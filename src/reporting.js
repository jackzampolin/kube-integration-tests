const influx = require('influx')

const schema = [
  {
    measurement: 'test_progress',
    fields: {
      total_tests: influx.FieldType.INTEGER,
      total_pods: influx.FieldType.INTEGER,
      total_nodes: influx.FieldType.INTEGER,
      comp_perc: influx.FieldType.FLOAT,
      comp: influx.FieldType.INTEGER,
      remain_perc: influx.FieldType.FLOAT,
      remain: influx.FieldType.INTEGER,
    },
    tags: [
      'test_run',
      'git_branch',
      'git_commit',
      'event_name'
    ]
  }
]

class Reporting {
  constructor (config) {
    let protocol = "http"
    if (config.influxSSL == "True") {
      protocol = "https"
    }
    this.client = new influx.InfluxDB({
      host: config.influxHost,
      database: 'testing',
      port: 8086,
      protocol: protocol,
      username: config.influxUser,
      password: config.influxPass,
      schema: schema
    })
  }

  logProgress (gitBranch, gitCommit, eventName, totalTests, totalPods, totalNodes, compPerc, comp, remainPerc, remain) {
    this.client.writePoints([
      {
        measurement: 'test_progress',
        tags: {
          test_run: `${gitBranch}-${gitCommit}`,
          git_branch: gitBranch,
          git_commit: gitCommit,
          event_name: eventName,
        },
        fields: {
          total_tests: totalTests,
          total_pods: totalPods,
          total_nodes: totalNodes,
          comp_perc: compPerc,
          comp: comp,
          remain_perc: remainPerc,
          remain: remain
        },
      }
    ]).catch(err => {
      console.error(`Error saving data to influxDB! ${err.stack}`)
    })
  }
}

module.exports = Reporting
