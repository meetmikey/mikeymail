var serverCommon = process.env.SERVER_COMMON;

var mikeyMailConstants = require ('../constants'),
    winston = require(serverCommon + '/lib/winstonWrapper').winston,
    sesUtils = require (serverCommon + '/lib/sesUtils'),
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose

var ResumeDownloadStateModel = mongoose.model ('ResumeDownloadState');

var resumesInProgress = 0;
var mongoPoll = this;

exports.startPollingResumeDownload = function (callback) {
  setInterval (function () {
    winston.doInfo ('poll mongo resume download')
    mongoPoll.pollForResumeDownload(function (err, foundResumeTask) {
      if (err) {
        winston.handleError (err);
      } else if (foundResumeTask) {
        resumesInProgress++;
        callback (foundResumeTask, mongoPoll.doneWithTaskCallback);
      }
    });
  }, mikeyMailConstants.MONGO_RESUME_DOWNLOAD_POLL_INTERVAL);
}


exports.doneWithTaskCallback = function (err, foundResumeTask, disableTask) {
  resumesInProgress--;
  winston.doInfo ('Decrementing resumes in progress', {inProgress: resumesInProgress});

  if (err) {
    winston.handleError (err);
  }

  if (foundResumeTask && disableTask) {
    mongoPoll.disableResumeTask (foundResumeTask);
  }
}

exports.disableResumeTask = function (foundResumeTask) {
  winston.doInfo ('disableResumeTask');
  ResumeDownloadStateModel.update ({_id : foundResumeTask._id}, 
    {$set : {disabled : true}}, 
    function (err) {
      if (err) {
        winston.doMongoError (err);
      }

      /*
      sesUtils.sendInternalNotificationEmail ('Resume task is being disabled ' + JSON.stringify(foundResumeTask), 'Resume download error', 
        function (err) {
          if (err) {
            winston.doError ('error sending internal notification email', err);
          }
        });
      */

    });
}
 

exports.pollForResumeDownload = function (callback) {
  var isoNow = new Date(Date.now()).toISOString();
  var isoNowWithBuffer = new Date (Date.now() - 
    (mikeyMailConstants.RESUME_DOWNLOAD_TIMESTAMP_RECLAIM_FACTOR * mikeyMailConstants.RESUME_DOWNLOAD_TIMESTAMP_INTERVAL)).toISOString();
  winston.doInfo ('pollForResumeDownload timestamps', {isoNow : isoNow, isoNowWithBuffer : isoNowWithBuffer});

  var query = {
    $or : [ 
      {mikeyMailTS : {$lte : isoNowWithBuffer}}, // the node doing the update hasn't updated the TS in awhile
      {mikeyMailTS : {$exists : false}} // nobody has claimed this node
    ], 
    resumeAt : {$lte : isoNow}, // we should resume now
    lastCompleted : {$ne : 'markStoppingPoint'}, // it's not done
    disabled : false // it's not disabled
  };

  var update = {$set : {nodeId : mikeyMailConstants.MY_NODE_ID, mikeyMailTS : Date.now()}};

  // find a non-claimed or stalled object that we need to continue updating the mailbox for
  ResumeDownloadStateModel.findOneAndUpdate (query, update, function (err, foundResumeDownload) {
    if (err) {
      callback (winston.makeMongoError (err));
    }
    else if (!foundResumeDownload) {
      // there's nothing to resume downloading for atm
      callback ();
    }
    else {
      callback (null, foundResumeDownload);
      winston.doInfo ('Incrementing resumes in progress', {inProgress: resumesInProgress});

      // we got a result so poll the database again immediately if we are under our limit
      if (resumesInProgress < mikeyMailConstants.MAX_RESUME_DOWNLOAD_JOBS) {
        mongoPoll.pollForResumeDownload (callback);
      }
    }
  });
}

// at intervals update the record in the db to indicate we are still
// here and still working on listening or downloading or resuming a downloading
exports.setWorkingTimestampLoop = function (Model, updateFrequency, modelId, callback) {
  winston.doInfo ('setWorkingTimestampLoop for model: ', {name : Model.modelName, nodeId : mikeyMailConstants.MY_NODE_ID, _id : modelId});
  
  var intervalId = setInterval (function () {
    Model.update ({_id : modelId, nodeId : mikeyMailConstants.MY_NODE_ID}, 
      {$set : {'nodeId' : mikeyMailConstants.MY_NODE_ID, 'mikeyMailTS' : Date.now()}}, 
      function (err, num) {
        if (err) {
          winston.doError ('Error: could not set nodeId: ', {error : err});
        }
        else if (num === 0) {
          winston.doWarn ('Zero records affected error: setWorkingTimestampLoop fail', {nodeId : mikeyMailConstants.MY_NODE_ID, modelName : Model.modelName, _id : modelId});

          // TODO: HACK CITY.. i can't figure out why the deleteTimestampInterval doesn't clear this out...
          if (Model.modelName == 'ActiveConnection') {
            clearInterval (intervalId);
          }
        }
        else {
          winston.doInfo ('setWorkingTimestampLoop success', {nodeId : mikeyMailConstants.MY_NODE_ID, modelName : Model.modelName, _id : modelId});
        }
      });
  }, updateFrequency);

  winston.doInfo ('setWorkingTimestampLoop intervalId', {intervalId : intervalId});
  callback (null, intervalId);

}

exports.clearTimeIntervalLoop = function (userId, intervalIds, source) {
  var keys = Object.keys(intervalIds)
  winston.doInfo('keys', {keys: keys});
  winston.doInfo ('clearTimeIntervalLoop for', {userId : userId, source : source});

  if (!(String (userId) in intervalIds)) {
    winston.doError ('No setTimestampIntervalIds for key', {userId : String(userId), intervalIdKeys : keys, source : source});
  }
  else {
    mongoPoll.deleteTimestampInterval (userId, intervalIds);
  }

}

exports.setTimestampInterval = function (key, value, intervalIds) {
  winston.doInfo ('setTimestampInterval', {key : key, value : value, ids : intervalIds});
  intervalIds[String (key)] = value;
}

exports.deleteTimestampInterval = function (key, intervalIds) {
  winston.doInfo ('deleteTimestampInterval');
  winston.doInfo('intervalIds for key', {intervalIds: intervalIds [String(key)], key: key});
  clearInterval (intervalIds [String(key)]);
  delete intervalIds[String (key)];
}