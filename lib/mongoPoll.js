var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants'),
    winston = require(serverCommon + '/lib/winstonWrapper').winston,
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose

var ActiveConnectionModel = mongoose.model ('ActiveConnection');
var MailboxModel = mongoose.model ('MailBox');
var ResumeDownloadStateModel = mongoose.model ('ResumeDownloadState')

var resumesInProgress = 0;
var mongoPoll = this;

exports.startPollingConnections = function (myUniqueId, callback) {
  // check every minute to see if we should drop any connections
  setInterval (function () {
    winston.info ('poll mongo active connections')
    mongoPoll.pollConnections(myUniqueId, callback);
  }, constants.MONGO_ACTIVE_CONNECTIONS_POLL_INTERVAL);
}

exports.startPollingResumeDownload = function (myUniqueId, callback) {
  winston.info ('startPollingResumeDownload');

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
  winston.info ('pollForResumeDownload');
  var isoNow = new Date(Date.now()).toISOString();

  // find a non-claimed object that we need to continue updating the mailbox for
  ResumeDownloadStateModel.findOneAndUpdate (
    {claimed : false, resumeAt : {$lte : isoNow}},
    {$set : {claimed : true}},
    {new : false},
    function (err, foundResumeDownload) {
      if (err) {
        console.log (err);
        winston.doError ({err : err});
        callback (err);
      }
      else if (!foundResumeDownload) {
        // there's nothing to resume downloading for atm, the poll will
        // automatically retry at it's regular interval
        winston.info ('nothing to update')
        callback ();
      }
      else {
        winston.info ('callback with resume download state')
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
  winston.info ('decrementResumesInProgress', {inProgress: resumesInProgress});
  resumesInProgress--;

  //TODO: figure out starvation case
//  if (resumesInProgress < constants.MAX_RESUME_DOWNLOAD_JOBS) {
//    mongoPoll.pollForResumeDownload (callback);
//  }
}

// at intervals update the record in the db to indicate we are still
// here and still working on listening or downloading or resuming a downloading
exports.setWorkingTimestampLoop = function (Model, updateFrequency, modelId, callback) {
  winston.info ('setWorkingTimestampLoop');
  
  var intervalId = setInterval (function () {
    winston.info ('update working timestamp');
    Model.update ({_id : modelId, nodeId : constants.MY_NODE_ID}, 
      {$set : {'nodeId' : constants.MY_NODE_ID, 'mikeyMailTS' : Date.now()}}, 
      function (err, num) {
        if (err) {
          callback (winston.makeError ('Error: could not set nodeId: ', {error : err}));
        }
        else if (num == 0) {
          winston.doWarn ('Zero records affected error setWorkingTimestampLoop', {nodeId : constants.MY_NODE_ID, _id : modelId});
          callback ();
        }
        else {
          winston.doInfo ('New setWorkingTimestampLoop callback with new intervalId', {intervalId : intervalId});
          callback ();
        }
      })  
  }, updateFrequency);

  callback (null, intervalId);

}