const express = require('express');
const moment = require('moment')
const fs = require('fs');
const path = require('path');
const git = require('git-rev-sync');
const bodyParser = require('body-parser');
const mkdirp = require('mkdirp');
const winston = require('winston');

const kubeClient = require('./src/kube.js');
const blockstackCore = require('./src/blockstack-core.js');
const reporting = require('./src/reporting.js');
const slackClient = require('./src/slack.js');

const logger = new winston.Logger({
  level: 'info',
  handleExceptions: true,
  stringify: false,
  timestamp: true,
  colorize: true,
  json: true,
  humanReadableUnhandledException: true,
  transports: [new (winston.transports.Console)()]
});

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
    if (tag.includes("develop") || tag.includes("master") || tag.includes("hotfix")) {
      out = tag
    }
  })
  return out
}

// Handle the webhook route
app.post('/', function (req, res) {

  // Pull branch information from request
  logger.info(`Post conatined following tags: ${req.body.updated_tags}`)
  let gitBranch = getTag(req.body.updated_tags);

  // Start timer
  let startTime = moment()

  // Check out the pushed branch of blockstack-core
  if (gitBranch !== "") {
    bs.checkoutRepo(gitBranch).done(() => {

      // Make the gitBranch safe for kubernetes
      gitBranch = gitBranch.replace("/","-")

      // Test constants
      const gitCommit = git.short(config.blockstackDir);
      const namespace = `${gitBranch}-${gitCommit}`;
      const tests = bs.getTests();

      // TODO: Move this into a seperate object and factor out these vars
      // Initalize reporting vars
      let numNodes = 0;
      let numPods = 0;
      let comp = 0;
      let compPerc = 0.0;
      let remain = tests.length;
      let remainPerc = 100.0;
      let failed = [];

      // TODO: Compose all the functions inside this
      // and then make this whole thing into a function
      // Create the namespace and then create tests in it
      kube.createNamespace(namespace).then((result) => {

        // TODO: Move this into a function
        // If the namespace creation is successful then log & slack.
        logger.info(`[${namespace}] Starting...`)
        kube.getNodes().then((result) => {
          numNodes = result.items.length;
          sl.send(`Test \`${namespace}\` started. Go to the dashboard to watch progress: \`https://monitoring.technofractal.com/sources/1/dashboards/7\`.`)
          influx.logProgress(gitBranch, gitCommit, "startStop", tests.length, numPods, numNodes, compPerc, comp, remainPerc, remain);
        }).catch((err) => { logger.error(err) });

        // Create test log folder
        mkdirp(`${__dirname}/test-out/${namespace}`, (err) => {
          if (err) { logger.info(err) }
        });


        logger.info(`[${namespace}] queueing ${tests.length} pods...`)

        // TODO: Move this into a function
        // Create 1 every 100ms to avoid flooding Kube API server
        let pods = 0;
        let podInterval = setInterval(() => {
          kube.createPod(gitBranch, gitCommit, tests[pods], tests.length).catch((err) => { logger.info(err) })
          pods++;
          if (pods >= tests.length) {
            logger.info(`[${namespace}] ${pods} started...`)
            clearInterval(podInterval)
          }
        }, 100)

        // TODO: Move this into a function
        // Start the background stats reporting routine
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
                      logger.error(`[${namespace}] test in ${podName} failed...`)
                      sl.send(`Test \`${podName}\` failed. Logs available: \`${config.serverName}/${filePath}\``)
                      fs.writeFileSync(`${__dirname}/test-out/${filePath}`, log)
                    }).catch((err) => { logger.info(err) })
                    failed.push(podName)
                  }
                }
                podStatuses[status] += 1
              })

              // TODO: Put all the metrics on the podStatuses object and refactor this out
              // Reset reporting vars and report
              numPods = result.items.length
              comp = podStatuses.succeeded + podStatuses.failed
              remain = podStatuses.running + podStatuses.pending
              compPerc = (comp / tests.length) * 100
              remainPerc = (remain /tests.length) * 100
              logger.info(`[${namespace}] comp: ${comp}, remain: ${remain}, iter: ${runs}`)
              influx.logProgress(gitBranch, gitCommit, "progress", tests.length, numPods, numNodes, compPerc, comp, remainPerc, remain)
            })
          }).catch((err) => { logger.info(err) })

          // Increment the number of runs
          runs++;

          // Check if the test is complete, if it is report
          let testLog = `[${namespace}] Run results:
    Test Time:    ${startTime.diff(moment(), 'minutes')}
    Number Tests: ${tests.length}
    Success Tests: ${tests.length - failed.length}
    Failed Tests: ${failed}`
          if (runs > 5 && numPods === 0) {
            logger.info(testLog)
            sl.send(`\`\`\`${testLog}\`\`\``)
            influx.logProgress(gitBranch, gitCommit, "startStop", tests.length, 0, numNodes, 100.0, tests.length, 0.0, 0);
            kube.deleteNamespace(namespace).then((ns) => { logger.info(`[${namespace}] Finshed...`) }).catch((err) => { logger.info(err) })
            clearInterval(interval);
          }

          // In the case of stalled pods, end the test and save the logs from the stalled pods
          if (runs >= 90) {
            influx.logProgress(gitBranch, gitCommit, "startStop", tests.length, 0, numNodes, 100.0, tests.length, 0.0, 0);
            sl.send(`\`\`\`${testLog}\`\`\``)
            logger.info(testLog)
            kube.getPods(namespace).then((result) => {
              let stalledPods = result.items.filter((pod) => { pod.status.phase.toLowerCase() === "running" })
              stalledPods.forEach((pod) => {
                let podName = pod.metadata.name
                kube.getLogs(namespace, podName).then((log) => {
                  let logsUrl = `https://${config.serverName}/test-out/${namespace}/${podName}`
                  sl.send(`Test \`${pod}\` stalled. Logs available: \`${logsUrl}\``)
                  fs.writeFileSync(`${__dirname}/test-out/${namespace}/${podName}`, log)
                }).catch((err) => { logger.info(err) })
              })
              kube.deleteNamespace(namespace).then((ns) => { logger.info(`[${namespace}] Finshed...`) }).catch((err) => { logger.info(err) })
            })
            clearInterval(interval);
          }
        }, 60000);

      // If the namespace fails to create then return and do not start test
      }).catch((err) => {
        logger.info(err)
      })

    })
  }
  res.send(JSON.stringify({"status": "ok"}))
})

// Serve the log files from `test-out`
app.use(express.static(path.resolve(__dirname, 'test-out')));

app.listen(config.bindPort, function () {
  logger.info(`Quay webhook server is listening on ${config.bindPort}...`)
})
