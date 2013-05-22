var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants'),
    imapConnect = require ('./imapConnect'),
    sqsConnect = require(serverCommon + '/lib/sqsConnect'),
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose,
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    async = require ('async'),
    mongoPoll = require ('./mongoPoll'),
    xoauth2 = require("xoauth2"),
    daemonUtils = require ('./daemonUtils');

var UserOnboardingStateModel = mongoose.model ('UserOnboardingState');
var myTimestampLoops = {};
var mailDownloadDaemon = this;

exports.start = function () {
  winston.info ('starting mail download daemon');

  sqsConnect.pollMailDownloadQueue(function (message, pollQueueCallback) {

    console.log ('mail download daemon got poll queue message', message);
    var userMsg = JSON.parse (message);
    daemonUtils.getUserInfoFromDB (userMsg._id, function (err, userInfo) {

      if (err) {
        pollQueueCallback (err);
        return;
      }

      var xoauthParams = daemonUtils.getXOauthParams (userInfo);
      var xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);

      UserOnboardingStateModel.findOne ({'userId' : userInfo._id}, function (err, foundState) {
        var ISORestartTime = new Date(Date.now() - constants.ONBOARDING_TIMESTAMP_UPDATE_INTERVAL * constants.ONBOARDING_TIMESTAMP_RECLAIM_FACTOR).toISOString();

        if (err) {
          pollQueueCallback (winston.makeMongoError (err));
        }
        else if (!foundState) {

          // mark new state object
          var state = new UserOnboardingStateModel({
            userId : userInfo._id,
            lastCompleted : 'gmailScrapeDequeued',
            nodeId : constants.MY_NODE_ID,
            mikeyMailTS : Date.now()
          });

          state.save (function (err) {
            if (err) {
              pollQueueCallback (winston.makeMongoError (err));
            }
            else {
              mailDownloadDaemon.scrapeMailbox (xoauth2gen, userInfo, state, true, pollQueueCallback);       
            }
          });

        }
        else if (foundState && foundState.lastCompleted== 'markStoppingPoint') {
          // message shouldn't be on queue onboarding complete
          pollQueueCallback();
        }
        else if (foundState && 
          foundState.nodeId && 
          foundState.mikeyMailTS.toISOString() < ISORestartTime) {

          winston.doInfo ('New node picking up and attempting to claim foundState', {ISORestartTime: ISORestartTime, userEmail : userInfo.email});

          // the onboarding was claimed, but the node that claimed it hasn't updated the work state
          // for factor times the expected time, claim this state for yourself and start worknig again under
          // the assumption that the node is dead
          mailDownloadDaemon.attemptToClaimOnboardingState (foundState, function (err, updatedState) {
            if (err) {
              pollQueueCallback (err);
            }
            else if (!updatedState) {
              winston.doWarn ('Onboarding state already claimed by different node');
              // TODO : this isn't really an error, but we need to call pollQueueCallback...
              pollQueueCallback (winston.makeError ({error : 'Race condition: Onboarding state already claimed by different node'}));
            }
            else {
              mailDownloadDaemon.scrapeMailbox (xoauth2gen, userInfo, foundState, false, pollQueueCallback);
            }
          });
        }
        else {
          winston.doInfo ('User onboarding previously started and threshold not high enough to restart', 
            {state : foundState._id, email : userInfo.email, restartTime : ISORestartTime});
          pollQueueCallback (winston.makeError ('User onboarding previously started and threshold not high enough to restart',
            {state : foundState._id, suppressError : true}));
        }
      });

    });

  }, constants.MAX_DOWNLOAD_JOBS);

};

/*
 * Performs initial onboarding for user
 */
exports.scrapeMailbox = function (xoauth2gen, userInfo, onboardingState, isFirstAttempt, pollQueueCallback) {
  winston.doInfo ('scrapeMailbox for user', {userEmail: userInfo.email});

  var onboardingStateId = onboardingState._id;

  var lastCompleted;

  if (!isFirstAttempt) {
    lastCompleted = onboardingState.lastCompleted;
  }

  xoauth2gen.getToken(function(err, token) {
    if(err){
      pollQueueCallback (winston.makeError ('Error: could not generate xoauth token: mailDownloadDaemon', 
        {error : err, userEmail : userInfo.email, suppressError : true}));

      // invalid grant = token must be invalid      
      if (err == 'invalid_grant') {
        daemonUtils.updateUserTokenValidity (userInfo._id);
      }

      return;
    }
   
    // connect to imap server
    var myConnection = imapConnect.createImapConnection (userInfo.email, token);
    
    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {
      if (err) {
        var errorType = winston.getErrorType (err);
        if (errorType === "ALL_MAIL_DOESNT_EXIST_ERR") {
          daemonUtils.updateErrorState (onboardingStateId, errorType);
          pollQueueCallback ();
        }
        else {
          pollQueueCallback(err);
        }
        return;
      }

      winston.info ('Connection opened for user: ' + userInfo.email);

      // update the onboarding state in the db to indicate that we're working on the user
      mongoPoll.setWorkingTimestampLoop (UserOnboardingStateModel,
        constants.ONBOARDING_TIMESTAMP_UPDATE_INTERVAL,
        onboardingStateId,
        function (err, intervalId) {
          if (err) {
            winston.handleError (err);
          }
          else {
            mongoPoll.setTimestampInterval (userInfo._id, intervalId, myTimestampLoops);
          }
        });

      var operations = [
        startAsync,
        daemonUtils.createOrLookupMailbox,
        daemonUtils.retrieveHeadersInBatch,
        daemonUtils.mapReduceContacts,
        daemonUtils.mapReduceReceiveCounts,
        daemonUtils.markAttachments,
        daemonUtils.markMarketingFromEmails,
        daemonUtils.markMarketingTextEmails,
        daemonUtils.retrieveEmails,
        daemonUtils.markStoppingPoint
      ];

      // all variables needed by async waterfall are passed in this object
      var argDict = {
        'userId' : userInfo._id,
        'userEmail' : userInfo.email,
        'isOnboarding' : true,
        'minUid' : 1,
        'myConnection' : myConnection,
        'onboardingStateId' : onboardingStateId,
        'totalBandwith' : 0,
        'mailbox' : mailbox,
        'recoveryMode' : false,
        'recoveryModeStartPoint' : 'startAsync',
        'isUpdate' : false
      };

      // find the starting point in the waterfall chain
      if (lastCompleted) {
        var opLen = operations.length;

        // this user has already been onboarded to completion, no reason to continue
        if (lastCompleted == operations[opLen-1].name) {
          pollQueueCallback ();
          return;
        }
        else {
          for (var i = 0; i < opLen; i++) {
            var operation = operations[i];

            if (operation.name == lastCompleted) {
              argDict.recoveryModeStartPoint = operations[i+1].name;
              argDict.recoveryMode = true;
              argDict.totalBandwith = onboardingState.bandwith;
              winston.info ('new starting point ' + operations[i+1].name);
              break;
            }

          }
        }
      }

      async.waterfall (operations, function (err) {

        winston.info ('mailDownloadDaemon: waterfall callback');
        mongoPoll.clearTimeIntervalLoop (userInfo._id, myTimestampLoops, 'downloadDaemon');

        if (err) {
          pollQueueCallback(err);
          daemonUtils.updateErrorState (onboardingStateId, err);
        }
        else {
          // close the mailbox
          imapConnect.closeMailbox (myConnection, function (err) {
            if (err) {
              winston.doError ('Could not close mailbox', err);
            }
            else {
              winston.doInfo ('mailbox closed for user ' + {userEmail : userInfo.email});
            }
          });

          pollQueueCallback ();
          winston.doInfo ('Finished downloading for user', {userEmail : userInfo.email});
        }

      });

      function startAsync (callback) {
        callback (null, argDict);
      }

    });
  });
};

exports.attemptToClaimOnboardingState = function (foundState, callback) {

  var findAttributes = {
    _id : foundState._id, 
    nodeId : foundState.nodeId
  };

  // update if current
  UserOnboardingStateModel.findOneAndUpdate (findAttributes, 
    {$set : {nodeId : constants.MY_NODE_ID, mikeyMailTS : Date.now()}},
    function (err, updatedState) {
    if (err) {
      callback (winston.makeMongoError (err));
    }
    else if (!updatedState) {
      winston.doWarn ('onboarding state not found with attributes: ', {_id : foundState._id, nodeId : foundState.nodeId} );
      callback (null, null);
    }
    else {
      callback (null, updatedState);
    }
  });

};
