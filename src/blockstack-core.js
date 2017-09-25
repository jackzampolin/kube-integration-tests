const nodegit = require('nodegit');
const fs = require('fs');

class BlockstackCore {
  constructor (config) {
    this.blockstackDir = config.blockstackDir
  }

  getTests () {
    let tests = fs.readdirSync(`${this.blockstackDir}/integration_tests/blockstack_integration_tests/scenarios`);
    let skips = fs.readFileSync(`${this.blockstackDir}/integration_tests/blockstack_integration_tests/tests_skip.txt`, 'UTF-8')
    let exclude = []
    let out = []

    // populate exclude list
    skips.split('\n').forEach((line) => {
      if (line.startsWith("#")) { return }
      exclude.push(line)
    })

    // populate tests
    tests.forEach((file) => {
      let test = file.split(".")[0]
      if (exclude.includes(test)) { return }
      out.push(test)
    })
    return out
  }

  checkoutRepo (branchName) {
    var repository
    return nodegit.Repository.open(this.blockstackDir)
      .then(function(repo) {
        repository = repo;
        return repository.fetchAll({
          callbacks: {
            credentials: (url, userName) => { return nodegit.Cred.sshKeyFromAgent(userName) },
            certificateCheck: () => { return 1 }
          }
        });
      }).then(function() {
        return repository.mergeBranches(branchName, `origin/${branchName}`);
      }).then(() => {
        return repository.getBranch(branchName)
        .then(function(reference) {
          return repository.checkoutRef(reference);
        });
      })
  }

}

module.exports = BlockstackCore
