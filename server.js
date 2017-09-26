const express = require('express');
const moment = require('moment')
const fs = require('fs');
const path = require('path');
const git = require('git-rev-sync');
const bodyParser = require('body-parser');
const mkdirp = require('mkdirp');

const kubeClient = require('./src/kube.js');
const blockstackCore = require('./src/blockstack-core.js');
const reporting = require('./src/reporting.js');
const slackClient = require('./src/slack.js');

// Instantiate express app
const app = express();

// read in config file
const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'config.json'), 'UTF-8'));

// Instantiate kube client
const kube = new kubeClient(config)

// Instantiate blockstackCore repo
const bs = new blockstackCore(config)

// Instantiate slack connection for reporting
const sl = new slackClient(config)

// Instantiate InfluxDB Client
const influx = new reporting(config)

// Parse JSON posts
app.use(bodyParser.json());

// Helper function for fetching the tag out of the array
function getTag (tags) {
  let out = ""
  tags.forEach((tag) => {
    if (tag.includes("develop") || tag.includes("master")) {
      out = tag
    }
  })
  return out
}

// Handle the webhook route
app.post('/', function (req, res) {
  // Pull branch information from request
  let gitBranch = getTag(req.body.updated_tags);

  // Start timer
  let startTime = moment()

  // Check out the pushed branch of blockstack-core
  bs.checkoutRepo(gitBranch).done(() => {
    // Test constants
    const gitCommit = git.short(config.blockstackDir);
    const namespace = `${gitBranch}-${gitCommit}`;
    const tests = bs.getTests();

    //  Initalize reporting vars
    let numNodes = 0;
    let numPods = 0;
    let comp = 0;
    let compPerc = 0.0;
    let remain = tests.length;
    let remainPerc = 100.0;
    let failed = [];

    // Log the start of the test
    console.log(`Test ${namespace} started...`);
    kube.getNodes().then((result) => {
      numNodes = result.items.length;
      sl.send(`Test \`${namespace}\` started. Go to the dashboard to watch progress: \`https://monitoring.technofractal.com/sources/1/dashboards/7\`.`)
      influx.logProgress(gitBranch, gitCommit, "startStop", tests.length, numPods, numNodes, compPerc, comp, remainPerc, remain);
    }).catch((err) => { console.log(err) });

    // Create test log folder
    mkdirp(`${__dirname}/testOut/${namespace}`, (err) => {
        if (err) { console.log(err) }
    });

    // Create the namespace and then create tests in it
    kube.createNamespace(namespace).then((result) => {
      console.log(`Number Queued:  ${tests.length}`)
      let runs = 0;
      // Create 10 / second to avoid flooding the API server
      let interval = setInterval(() => {
        kube.createPod(gitBranch, gitCommit, tests[runs], tests.length).catch((err) => { console.log(err) })
        runs++;
        if (runs >= tests.length) {
          console.log(`Number Started: ${runs}`)
          clearInterval(interval)
        }
      }, 100)
    }).catch((err) => { console.log(err) })

    res.send(JSON.stringify({"status": "ok"}))

    // Check progress on the test every 1 minute
    let runs = 0;
    let interval = setInterval(() => {

      // Get node data
      kube.getNodes().then((result) => {
        numNodes = result.items.length;
        // Get pod data
        kube.getPods(namespace).then((result) => {
          // Store pod statuses for reporting
          let podStatuses = {
            "succeeded": 0,
            "pending": 0,
            "failed": 0,
            "running": 0
          }

          // Save failed pods logs if not seen before
          result.items.forEach((item) => {
            let status = item.status.phase.toLowerCase()
            if (status === "failed") {
              let podName = item.metadata.name
              if (!failed.includes(podName)) {
                kube.getLogs(namespace, podName).then((log) => {
                  let filePath = `${namespace}/${podName}`
                  console.log(`Test ${podName} failed...`)
                  sl.send(`Test \`${podName}\` failed. Logs available: \`${config.serverName}/${filePath}\``)
                  fs.writeFileSync(`${__dirname}/testOut/${filePath}`, log)
                }).catch((err) => { console.log(err) })
              }
              failed.push(podName)
            }
            podStatuses[status] += 1
          })

          // Reset reporting vars and report
          numPods = result.items.length
          comp = podStatuses.succeeded + podStatuses.failed
          remain = podStatuses.running + podStatuses.pending
          compPerc = (comp / tests.length) * 100
          remainPerc = (remain /tests.length) * 100
          console.log(`Completed: ${comp}, Remaining: ${remain}, Iterations: ${runs}`)
          influx.logProgress(gitBranch, gitCommit, "progress", tests.length, numPods, numNodes, compPerc, comp, remainPerc, remain)
        })
      }).catch((err) => { console.log(err) })

      // Increment the number of runs
      runs++;

      // Check if the test is complete, if it is report
      let testLog = `Integration Test Run Results for ${namespace}:
  Test Time:    ${startTime.diff(moment(), 'minutes')}
  Number Tests: ${tests.length}
  Success Tests: ${tests.length - failed.length}
  Failed Tests: ${failed}`
      if (runs > 5 && numPods === 0) {
        console.log(testLog)
        sl.send(`\`\`\`${test.log}\`\`\``)
        influx.logProgress(gitBranch, gitCommit, "startStop", tests.length, 0, numNodes, 100.0, tests.length, 0.0, 0);
        kube.deleteNamespace(namespace).then((ns) => { console.log(`Test ${namespace} finshed and cleaned up...`)}).catch((err) => { console.log(err) })
        clearInterval(interval);
      }

      // In the case of stalled pods, end the test and save the logs from the stalled pods
      if (runs >= 90) {
        influx.logProgress(gitBranch, gitCommit, "startStop", tests.length, 0, numNodes, 100.0, tests.length, 0.0, 0);
        sl.send(`\`\`\`${test.log}\`\`\``)
        console.log(testLog)
        kube.getPods(namespace).then((result) => {
          let stalledPods = result.items.filter((pod) => { pod.status.phase.toLowerCase() === "running" })
          stalledPods.forEach((pod) => {
            let podName = pod.metadata.name
            kube.getLogs(namespace, podName).then((log) => {
              let logsUrl = `https://${config.serverName}/testOut/${namespace}/${podName}`
              sl.send(`Test \`${pod}\` stalled. Logs available: \`${logsUrl}\``)
              fs.writeFileSync(`${__dirname}/testOut/${namespace}/${podName}`, log)
            }).catch((err) => { console.log(err) })
          })
          kube.deleteNamespace(namespace).then((ns) => { console.log(`Test ${namespace} finshed and cleaned up...`)}).catch((err) => { console.log(err) })
        })
        clearInterval(interval);
      }
    }, 60000);

  })
})

// Serve the log files from `test-out`
app.use(express.static(path.resolve(__dirname, 'test-out')));

app.listen(config.bindPort, function () {
  console.log(`Quay webhook server is listening on ${config.bindPort}...`)
})
