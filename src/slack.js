var rp = require('request-promise-native');

// TODO: add logger to config and pass here to catch that error
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
