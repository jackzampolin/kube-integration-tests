const kube = require('kubernetes-client');

class Kube {
  constructor (config) {
    this.influxHost = config.influxHost
    this.influxUser = config.influxUser
    this.influxPass = config.influxPass
    this.influxSSL = config.influxSSL
    this.client = new kube.Core(kube.config.fromKubeconfig(kube.config.loadKubeconfig(config.kubeConfigPath)));
  }

  createNamespace (namespace) {
    let client = this.client
    return new Promise((resolve, reject) => {
      client.ns.post({
        body: {
         "apiVersion":"v1",
         "kind": "Namespace",
         "metadata": {
           "name": namespace
         },
         "spec": {
           "finalizers": ["kubernetes"]
         },
         "status": {
           "phase": "Active"
         },
         "labels": {
           "name": namespace
         }
       }
      }, (err, res) => {
        if (err !== null) {
          reject(err)
        } else {
          resolve(res)
        }
      })
    })
  }

  deleteNamespace (namespace) {
    let client = this.client
    return new Promise((resolve, reject) => {
      client.namespaces.delete(namespace, (err, res) => {
        if (err !== null) {
          reject(err)
        }
        resolve(res)
      })
    })
  }

  createPod (gitBranch, gitCommit, test, numTests) {
    let client = this.client
    let self = this
    return new Promise((resolve, reject) => {
      let pod = self.podJSON(gitBranch, gitCommit, test, numTests)
      client.namespaces(`${gitBranch}-${gitCommit}`).pods.post(pod, (err, res) => {
        if (err !== null) {
          reject(err)
        }
        resolve(res)
      })
    })
  }

  getPods (namespace) {
    let client = this.client
    return new Promise((resolve, reject) => {
      client.namespaces(namespace).pods.get((err, res) => {
        if (err !== null) {
          reject(err)
        }
        resolve(res)
      })
    })
  }

  getLogs (namespace, pod) {
    let client = this.client
    return new Promise((resolve, reject) => {
      client.namespaces(namespace).pods(pod).log.get((err, res) => {
        if (err !== null) {
          reject(err)
        }
        resolve(res)
      })
    })
  }

  getNodes () {
    let client = this.client
    return new Promise((resolve, reject) => {
      client.nodes.get((err, res) => {
        if (err !== null) {
          reject(err)
        }
        resolve(res)
      })
    })
  }

  podJSON (gitBranch, gitCommit, test, numTests) {
    let testName = test.replace(/_/g, "-")
    return {
      body: {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": { "name": testName, "namespace": `${gitBranch}-${gitCommit}`, "labels": { "test": testName } },
        "spec": {
          "restartPolicy": "Never",
          "containers": [
            {
              "name": "integration-test-run",
              "image": `quay.io/blockstack/integrationtests:${gitBranch}`,
              "imagePullPolicy": "Always",
              "command": [ "blockstack-test-scenario", `blockstack_integration_tests.scenarios.${test}`, "--influx" ],
              "env": [
                { "name": "GIT_COMMIT", "value": `${gitCommit}` },
                { "name": "GIT_BRANCH", "value": `${gitBranch}` },
                { "name": "INFLUX_HOST", "value": `${this.influxHost}` },
                { "name": "INFLUX_USER", "value": `${this.influxUser}` },
                { "name": "INFLUX_PASS", "value": `${this.influxPass}` },
                { "name": "INFLUX_SSL", "value": `${this.influxSSL}`, },
                { "name": "NUM_TESTS", "value": `${numTests}` }
              ],
              "resources": {
                "limits": { "cpu": "1000m", "memory": "4Gi" },
                "requests": { "cpu": "1000m", "memory": "1Gi" }
              }
            }
          ]
        }
      }
    }
  }
}

module.exports = Kube
