# `kube-integration-tests`

This is the Blockstack integration test runner. It is designed to run the full suite of [`integration_tests`](https://github.com/blockstack/blockstack-core/tree/master/integration_tests) for `blockstack-core`. Running the tests serially takes upwards of 1.75 _days_ on an individual machine hence the need for a distributed solution to reduce time to feedback for developers.

### How it works

The flow for this system is as follows:
- [`integrationtests` Containers](https://github.com/blockstack/blockstack-core/blob/master/integration_tests/deployment/docker/Dockerfile.tests) are built for each push to the `blockstack-core` github repository by quay
- Once the build is complete, a webhook is pushed to this server. The JSON format is as follows:

```json
{
  "name": "integrationtests",
  "repository": "blockstack/integrationtests",
  "namespace": "blockstack",
  "docker_url": "quay.io/blockstack/integrationtests",
  "homepage": "https://quay.io/repository/blockstack/integrationtests",
  "updated_tags": [
    "master",
    "latest"
  ]
}
```

- The `kube-integration-tests` server parses the webhook and checks out a branch on a local copy of the `blockstack-core` repo and parses out the git SHA to uniquely identify the test: `master-09c5388`. This ID is used through out the system as an ID for the test run.
- Then it creates a Namespace (`master-09c5388`) in the configured `kubernetes` cluster and runs [each test](https://github.com/blockstack/blockstack-core/tree/master/integration_tests/blockstack_integration_tests/scenarios) that is not on the [excluded list](https://github.com/blockstack/blockstack-core/blob/master/integration_tests/blockstack_integration_tests/tests_skip.txt) for that branch in a separate pod.
- The Slack incoming webhook is notified of test start with a link to the Chronograf dashboard. The test start is also recorded in InfluxDB.
- Every minute while the test is running the cluster is polled. Logs for any failed tests are saved to a file on the server and Slack is notified with the URL to download those logs. Stats are also recorded to InfluxDB for visualization on the test dashboard in Chronograf.
- Once all of the tests have completed, or the 90 minute timeout has been reached, the Kubernetes namespace is torn down and a summary of the tests is posted to Slack.

### Components

`kube-integration-tests` stitches together a number of services:

- [Kubernetes](https://github.com/kubernetes/kubernetes) - The platform where test containers are run
  * Details on the cluster setup are below
  * This server uses the [GoDaddy simplified client for node](https://github.com/godaddy/kubernetes-client) as it only needs to create pods and namespaces.
  * Code for the cluster interaction is in `src/kube.js`
- [Quay](https://quay.io) - A container registry that also provides webhooks.
- [InfluxDB](https://github.com/influxdata/influxdb) - a stats backend for the testing framework. Records info for each test as well as progress of the tests as a whole.
  * Code for the InfluxDB interactions is in `src/reporting.js`
- [Slack](https://slack.com) - For alerting on tests
  * Code for the Slack interactions is in `src/slack.js`
- [Chronograf](https://github.com/influxdata/chronograf) - For providing realtime test results. The following queries are used:
  * Graph of completion percentage: `SELECT "comp_perc", "remain_perc" FROM "testing"."autogen"."test_progress" WHERE "test_run"=:test_run:`
  * Successful tests: `SELECT count("runtime") AS "count_runtime" FROM "testing"."autogen"."integration_tests" WHERE "status"='success' AND "test_run"=:test_run:`
  * Failed tests: `SELECT count("runtime") AS "count_runtime" FROM "testing"."autogen"."integration_tests" WHERE "status"='failure' AND "test_run"=:test_run:`
  * Completed tests: `SELECT last("comp") AS "last_comp" FROM "testing"."autogen"."test_progress" WHERE "test_run"=:test_run:`
  * Stalled or Remaining: `SELECT last("remain") AS "mean_remain" FROM "testing"."autogen"."test_progress" WHERE "test_run"=:test_run:`
  * Ad-hoc queries are used to compare across tests
- [Nginx](https://nginx.com) - For serving test logs and providing `https`
  * There is a sample nginx config in this repo: `nginx.conf.sample`

### Configuration

There is a sample configuration file at `config.sample.json`. Copy it to `config.json` and input your details:

```json
{
  "serverName": "foo.example.com",
  "chronografUrl": "https://chronograf.example.com/sources/1/dashboards/1",
  "influxHost": "influx.example.com",
  "influxUser": "admin",
  "influxPass": "admin",
  "influxSSL": "False",
  "blockstackDir": "/path/to/blockstack-core",
  "bindPort": 3000,
  "slackURL": "https://hooks.slack.com/services/XXXXXXXXX/XXXXXXXXX/XXXXXXXXXXXXXXXXXXXXXXXX",
  "kubeConfigPath": "/path/to/.kube/config"
}
```

### Kubernetes Configuration

These tests require a substantial amount of CPU and only run occasionally so cluster autoscaling is a requirement for this usecase. Blockstack uses Azure for our cloud deployments, and to autoscale clusters there you need to spin one up via [`acs-engine`](https://github.com/Azure/acs-engine). The deployment also needs a properly configured [autoscaler](https://github.com/wbuchwalter/Kubernetes-acs-engine-autoscaler) deployment. I've found [this article](https://medium.com/@wbuchwalter/autoscaling-a-kubernetes-cluster-created-with-acs-engine-on-azure-5e24ddc6402e) particularly helpful in setting this up.
