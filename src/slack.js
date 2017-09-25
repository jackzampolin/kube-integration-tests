var rp = require('request-promise-native');

class SlackClient {
  constructor (config) {
    this.slackUrl = config.slackURL
  }

  send (message) {
    let slackUrl = this.slackUrl
    var options = { method: 'POST', uri: slackUrl, body: {text: message}, json: true };
    rp(options).catch((err) => { console.log(err) });
  }
}

module.exports = SlackClient
