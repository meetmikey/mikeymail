var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants'),
    winston = require(serverCommon + '/lib/winstonWrapper').winston,
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose

var ActiveConnectionModel = mongoose.model ('ActiveConnection');
var ResumeDownloadStateModel = mongoose.model ('ResumeDownloadState');

// TODO: global variable in a awkward spot since this is a shared lib
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
  var isoNow = new Date(Date.now()).toISOString();
  var isoNowWithBuffer = new Date (Date.now() - (constants.RESUME_DOWNLOAD_TIMESTAMP_RECLAIM_FACTOR * constants.RESUME_DOWNLOAD_TIMESTAMP_INTERVAL)).toISOString();
  winston.info ('pollForResumeDownload timestamps', {isoNow : isoNow, isoNowWithBuffer : isoNowWithBuffer});

  // find a non-claimed or stalled object that we need to continue updating the mailbox for
  ResumeDownloadStateModel.findOneAndUpdate (
    {$or : [ {mikeyMailTS : {$lte : isoNowWithBuffer}}, {mikeyMailTS : {$exists : false}}], 
      resumeAt : {$lte : isoNow}, lastCompleted : {$ne : 'markStoppingPoint'}},
    {$set : {nodeId : constants.MY_NODE_ID, mikeyMailTS : Date.now()}},
    function (err, foundResumeDownload) {
      if (err) {
        callback (winston.makeMongoError (err));
      }
      else if (!foundResumeDownload) {
        // there's nothing to resume downloading for atm, the poll will
        // automatically retry at it's regular interval
        callback ();
      }
      else {
        callback (null, foundResumeDownload);
        resumesInProgress++;
        winston.doInfo ('Incrementing resumes in progress', {inProgress: resumesInProgress});

        // we got a result so poll the database again immediately if we are under our limit
        if (resumesInProgress < constants.MAX_RESUME_DOWNLOAD_JOBS) {
          mongoPoll.pollForResumeDownload (callback);
        }
      }
    });
}

exports.decrementResumesInProgress = function () {
  winston.doInfo ('decrementResumesInProgress', {inProgress: resumesInProgress});
  resumesInProgress--;
}

// at intervals update the record in the db to indicate we are still
// here and still working on listening or downloading or resuming a downloading
exports.setWorkingTimestampLoop = function (Model, updateFrequency, modelId, callback) {
  winston.doInfo ('setWorkingTimestampLoop for model: ', {name : Model.modelName, nodeId : constants.MY_NODE_ID, _id : modelId});
  
  var intervalId = setInterval (function () {
    Model.update ({_id : modelId, nodeId : constants.MY_NODE_ID}, 
      {$set : {'nodeId' : constants.MY_NODE_ID, 'mikeyMailTS' : Date.now()}}, 
      function (err, num) {
        if (err) {
          winston.doError ('Error: could not set nodeId: ', {error : err});
        }
        else if (num == 0) {
          winston.doWarn ('Zero records affected error: setWorkingTimestampLoop fail', {nodeId : constants.MY_NODE_ID, modelName : Model.modelName, _id : modelId});

          // TODO: HACK CITY.. i can't figure out why the deleteTimestampInterval doesn't clear this out...
          if (Model.modelName == 'ActiveConnection') {
            clearInterval (intervalId);
          }
        }
        else {
          winston.doInfo ('setWorkingTimestampLoop success', {nodeId : constants.MY_NODE_ID, modelName : Model.modelName, _id : modelId});
        }
      });
  }, updateFrequency);

  callback (null, intervalId);

}

exports.clearTimeIntervalLoop = function (userId, intervalIds, source) {
  var keys = Object.keys(intervalIds)
  console.log ('keys', keys);

  winston.info ('clearTimeIntervalLoop for', {userId : userId, source : source});

  if (!(String (userId) in intervalIds)) {
//    var keys = Object.keys(intervalIds)
    winston.doError ('No setTimestampIntervalIds for key', {userId : String(userId), intervalIdKeys : keys, source : source});
  }
  else {
    mongoPoll.deleteTimestampInterval (userId, intervalIds);
  }

}

exports.setTimestampInterval = function (key, value, intervalIds) {
  intervalIds[String (key)] = value;
}

exports.deleteTimestampInterval = function (key, intervalIds) {
  winston.info ('deleteTimestampInterval');
  console.log (intervalIds [String(key)]);
  clearInterval (intervalIds [String(key)]);
  delete intervalIds[String (key)];
}