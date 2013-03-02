var constants = require ('../constants'),
    winston = require(constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose

var ActiveConnectionModel = mongoose.model ('ActiveConnection');
var MailboxModel = mongoose.model ('MailBox');
var ResumeDownloadStateModel = mongoose.model ('ResumeDownloadState')

var resumesInProgress = 0;
var intervalId;
var mongoPoll = this;

exports.startPollingConnections = function (myUniqueId, callback) {
  // check every minute to see if we should drop any connections
  setInterval (function () {
    winston.info ('poll mongo active connections')
    mongoPoll.pollConnections(myUniqueId, callback);
  }, constants.MONGO_ACTIVE_CONNECTIONS_POLL_INTERVAL);
}

exports.startPollingOfflineUpdates = function (myUniqueId, callback) {
  // check every minute to see if we should drop any connections
  setInterval (function () {
    winston.info ('poll mongo offline updates')
    mongoPoll.pollForOfflineUpdates(myUniqueId, callback);
  }, constants.MONGO_OFFLINE_UPDATE_POLL_INTERVAL);
}

exports.startPollingResumeDownload = function (myUniqueId, callback) {
  // check every minute to see if we should drop any connections
  setInterval (function () {
    winston.info ('poll mongo resume download')
    mongoPoll.pollForResumeDownload(myUniqueId, callback);
  }, constants.MONGO_RESUME_DOWNLOAD_POLL_INTERVAL);
}

exports.pollConnections = function (myUniqueId, callback) {
  winston.info ('mikeymail polling for active connections', myUniqueId);
  ActiveConnectionModel.find({nodeId : myUniqueId}, 'userId', 
    function (err, foundConnections) {
      callback (err, foundConnections);
    });
}

exports.pollForResumeDownload = function (callback) {
  var isoNow = new Date(Date.now()).toISOString();

  // find a non-claimed object that we need to continue updating the mailbox for
  ResumeDownloadStateModel.findOneAndUpdate ({claimed : false, resumeAt : {$lte : isoNow}},
    {$set : {claimed : true}},
    function (err, foundResumeDownload) {
      console.log (foundResumeDownload)
      if (err) {
        winston.doError ('mongo error pollForResumeDownload', {error : err});
        callback (err);
      }
      else if (!foundResumeDownload) {
        // there's nothing to resume downloading for atm, the poll will
        // automatically retry at it's regular interval
        winston.info ('nothing to update')
        callback ();
      }
      else {
        callback (null, foundResumeDownload);
        resumesInProgress++;

        // we got a result so poll the database again if we are under our limit
        if (resumesInProgress < constants.MAX_RESUME_DOWNLOAD_JOBS) {
          mongoPoll.pollForResumeDownload (callback);
        }
      }
    });
}

exports.decrementResumesInProgress = function () {
  resumesInProgress--;

  //TODO: figure out starvation case
//  if (resumesInProgress < constants.MAX_RESUME_DOWNLOAD_JOBS) {
//    mongoPoll.pollForResumeDownload (callback);
//  }
}

exports.pollForOfflineUpdates = function (callback) {
  winston.info ('mikeymail polling for offline updates');
  MailboxModel.find ({})
    .where ('lastUpdate').gte (Date.now() - constants.OFFLINE_UPDATE_INTERVAL)
    .exec (function (err, mailboxes) {
      if (err) {
        winston.doError ('Error polling for offline updates', {err : err});
      }
      else if (mailboxes && mailboxes.length) {
        var userIds = mailboxes.map (function (mailbox) {return mailbox.userId;})

        // TODO: when we have multiple daemons running update mode we may get a
        // conflict here where two agents are simultaneously updating a single account
        

      }
    });
}
