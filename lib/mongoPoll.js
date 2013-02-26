var constants = require ('../constants'),
    winston = require(constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose

var ActiveConnectionModel = mongoose.model ('ActiveConnection');
var MailboxModel = mongoose.model ('MailBox');
var mongoPoll = this;

exports.startPollingConnections = function (myUniqueId, callback) {
  // check every minute to see if we should drop any connections
  setInterval (function () {
    winston.info ('poll mongo')
    mongoPoll.pollConnections(myUniqueId, callback);
  }, constants.MONGO_ACTIVE_CONNECTIONS_POLL_INTERVAL);

}
/*
exports.startPollingOfflineUpdates = function (myUniqueId, callback) {
  // check every minute to see if we should drop any connections
  setInterval (function () {
    winston.info ('poll mongo')
    mongoPoll.pollForOfflineUpdates(myUniqueId, callback);
  }, constants.MONGO_OFFLINE_UPDATE_POLL_INTERVAL);

}
*/
exports.pollConnections = function (myUniqueId, callback) {
  winston.info ('mikeymail polling for active connections');
  ActiveConnectionModel.find({nodeId : myUniqueId}, 'userId', 
    function (err, foundConnections) {
      callback (err, foundConnections)
    })
}

/*
exports.pollForOfflineUpdates = function (callback) {
  winston.info ('mikeymail polling for offline updates');
  MailboxModel.find ({})
    .where ('lastUpdate').gte (Date.now() - constants.OFFLINE_UPDATE_INTERVAL)
    .exec (function (err, mailboxes) {
      if (err) {
        winston.doError ('Error polling for offline updates', {err : err});
      }
      else if (mailboxes && mailboxes.length) {
        var userIds = mailboxes.forEach (function (mailbox) { })
        var oldDate = mailbo

        // TODO: when we have multiple daemons running update mode we may get a
        // conflict here where two agents are simultaneously updating a single account

        mailboxes.
      }
    });
}
*/