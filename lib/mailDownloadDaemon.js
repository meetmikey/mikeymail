var serverCommon = process.env.SERVER_COMMON;

var mikeymailConstants = require ('../constants'),
    constants = require(serverCommon + '/constants'),
    imapConnect = require ('./imapConnect'),
    sqsConnect = require(serverCommon + '/lib/sqsConnect'),
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose,
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    async = require ('async'),
    googleUtils = require (serverCommon + '/lib/googleUtils'),
    mongoPoll = require ('./mongoPoll'),
    xoauth2 = require("xoauth2"),
    daemonUtils = require ('./daemonUtils');

var UserOnboardingStateModel = mongoose.model ('UserOnboardingState');
var myTimestampLoops = {};
var mailDownloadDaemon = this;

exports.start = function () {
  winston.doInfo ('starting mail download daemon');

  sqsConnect.pollMailDownloadQueue(function (message, pollQueueCallback) {

    winston.doInfo('mail download daemon got poll queue message', {message:message});
    var userMsg = JSON.parse (message);
    daemonUtils.getUserInfoFromDB (userMsg._id, function (err, user) {

      if (err) {
        return pollQueueCallback (err);
      }

      // get a fresh access token
      googleUtils.getAccessToken (user._id, function (err, accessToken) {
        if (err) {
          return pollQueueCallback (err);
        }

        user.accessToken = accessToken;
        var xoauthParams = daemonUtils.getXOauthParams (user);
        var xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);

        UserOnboardingStateModel.findOne ({'userId' : user._id}, function (err, foundState) {
          var ISORestartTime = new Date(Date.now() - mikeymailConstants.ONBOARDING_TIMESTAMP_UPDATE_INTERVAL * mikeymailConstants.ONBOARDING_TIMESTAMP_RECLAIM_FACTOR).toISOString();

          if (err) {
            pollQueueCallback (winston.makeMongoError (err));
          }
          else if (!foundState) {

            // mark new state object
            var state = new UserOnboardingStateModel({
              userId : user._id,
              lastCompleted : 'gmailScrapeDequeued',
              nodeId : mikeymailConstants.MY_NODE_ID,
              mikeyMailTS : Date.now()
            });

            state.save (function (err) {
              if (err) {
                pollQueueCallback (winston.makeMongoError (err));
              }
              else {
                // (xoauth2gen, user, onboardingState, isFirstAttempt, pollQueueCallback)
                mailDownloadDaemon.scrapeMailbox (xoauth2gen, user, state, true, pollQueueCallback);       
              }
            });

          }
          else if (foundState && foundState.lastCompleted == 'markStoppingPoint') {
            // message shouldn't be on queue onboarding complete
            pollQueueCallback();
          }
          else if (foundState && 
            foundState.nodeId && 
            foundState.mikeyMailTS.toISOString() < ISORestartTime) {
            // the onboarding was claimed, but the node that claimed it hasn't updated the work state
            // for factor times the expected time, claim this state for yourself and start worknig again under
            // the assumption that the node is dead

            winston.doInfo ('New node picking up and attempting to claim foundState', {ISORestartTime: ISORestartTime, userEmail : user.email});
            mailDownloadDaemon.attemptToClaimOnboardingState (foundState, function (err, updatedState) {
              if (err) {
                pollQueueCallback (err);
              }
              else if (!updatedState) {
                winston.doWarn ('Onboarding state claimed by different node');
                pollQueueCallback (winston.makeError ('Race condition: Onboarding state already claimed by different node', {suppressError : true}));
              }
              else {
                mailDownloadDaemon.scrapeMailbox (xoauth2gen, user, foundState, false, pollQueueCallback);
              }
            });
          }
          else {
            winston.doInfo ('User onboarding previously started and threshold not high enough to restart', 
              {state : foundState._id, email : user.email, restartTime : ISORestartTime});
            pollQueueCallback (winston.makeError ('User onboarding previously started and threshold not high enough to restart',
              {state : foundState._id, suppressError : true}));
          }
        });
      });
    });
  }, mikeymailConstants.MAX_DOWNLOAD_JOBS);

};

/*
 * Performs initial onboarding for user
 */
exports.scrapeMailbox = function (xoauth2gen, user, onboardingState, isFirstAttempt, pollQueueCallback) {
  winston.doInfo ('scrapeMailbox for user', {userEmail: user.email});

  var onboardingStateId = onboardingState._id;

  var lastCompleted;
  if (!isFirstAttempt) {
    lastCompleted = onboardingState.lastCompleted;
  }

  xoauth2gen.getToken(function(err, token) {
    if(err){
      // invalid grant = token must be invalid      
      if (err == 'invalid_grant') {
        winston.doWarn ('Error : could not generate xoauth token: mailDownloadDaemon: invalid_grant');
        daemonUtils.updateUserTokenValidity (user._id, function (err) {
          if (err) { 
            pollQueueCallback (err);
          } else {
            pollQueueCallback ();
          }
        });
      } else {
        // some other error type
        pollQueueCallback (winston.makeError ('Error: could not generate xoauth token: mailDownloadDaemon', 
        {error : err, userEmail : user.email}));
      }
      return;
    }
   
    // connect to imap server
    var myConnection = imapConnect.createImapConnection (user.email, token);
    
    // open mailbox
    imapConnect.openMailbox (myConnection, user.email, function (err, mailbox) {
      if (err) {
        var errorType = winston.getErrorType (err);
        if (errorType === mikeymailConstants.ERROR_TYPE_ALL_MAIL_DOESNT_EXIST ||
            errorType === mikeymailConstants.ERROR_TYPE_NO_BOX_TO_OPEN) {

          daemonUtils.updateErrorState (onboardingStateId, errorType);
          daemonUtils.setUserAllMailError (true, user, errorType, pollQueueCallback);
        }
        else if (errorType === mikeymailConstants.ERROR_TYPE_IMAP_DOMAIN_ERROR) {
          daemonUtils.setUserImapDisabledError (true, user, pollQueueCallback);

        } else if (errorType === 'ECONNRESET' || errorType === 'ETIMEDOUT') {
          winston.doWarn ('connection closed unexpectedly, clearing time interval loop for user', {email : user.email});
          mongoPoll.clearTimeIntervalLoop (user._id, myTimestampLoops, 'downloadDaemon');
        }
        else {
          pollQueueCallback(err);
        }
        return;
      }

      // clear out old errors if they exist
      if (user.allMailError) { daemonUtils.unSetUserAllMailError (user); }

      winston.doInfo('Connection opened for user: ' + user.email);

      // update the onboarding state in the db to indicate that we're working on the user
      mongoPoll.setWorkingTimestampLoop (UserOnboardingStateModel,
        mikeymailConstants.ONBOARDING_TIMESTAMP_UPDATE_INTERVAL,
        onboardingStateId,
        function (err, intervalId) {
          if (err) {
            winston.handleError (err);
          }
          else {
            mongoPoll.setTimestampInterval (user._id, intervalId, myTimestampLoops);
          }
        });

      var operations = [
        startAsync,
        daemonUtils.createOrLookupMailbox,
        daemonUtils.retrieveHeadersInBatch,
        daemonUtils.markAttachments,
        daemonUtils.markMarketingFromEmails,
        daemonUtils.markMarketingTextEmails,
        daemonUtils.setMaxDate,
        daemonUtils.retrieveEmails,
        daemonUtils.setLastResumeDownloadDate,
        daemonUtils.markStoppingPoint
      ];

      var currentTime = Date.now();

      // all variables needed by async waterfall are passed in this object
      var argDict = {
        'userId' : user._id,
        'userEmail' : user.email,
        'isOnboarding' : true,
        'minUid' : 1,
        'myConnection' : myConnection,
        'onboardingStateId' : onboardingStateId,
        'totalBandwith' : 0,
        'mailbox' : mailbox,
        'recoveryMode' : false,
        'recoveryModeStartPoint' : 'startAsync',
        'isUpdate' : false,
        'isPremium' : user.isPremium,
        'minProcessedDate' : new Date(currentTime),
        'minDate' : new Date(currentTime - user.daysLimit*constants.ONE_DAY_IN_MS),
        'earliestEmailDate' : new Date(currentTime)
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
              winston.doInfo('new starting point ' + operations[i+1].name);
              break;
            }

          }
        }
      }

      if (argDict.recoveryMode) {
        daemonUtils.getBandwithForUserDay (user._id, function (err, bandwith) {
          if (err) {
            pollQueueCallback (err);            
          } else {
            argDict.totalBandwith = bandwith;
            startWaterfall();            
          }
        });
      } 
      else {
        startWaterfall();
      }

      function startWaterfall() {
        async.waterfall (operations, function (err) {

          winston.doInfo('mailDownloadDaemon: waterfall callback');
          mongoPoll.clearTimeIntervalLoop (user._id, myTimestampLoops, 'downloadDaemon');

          if (err) {
            pollQueueCallback(err);
            daemonUtils.updateErrorState (onboardingStateId, err);
          }
          else {
            // close the mailbox
            imapConnect.closeMailbox (myConnection, function (err) {
              if (err) {
                winston.doError ('Could not close mailbox', {err : err});
              }
              else {
                imapConnect.logout (myConnection, function (err) {
                  if (err) {
                    winston.doError ('Could not logout', {err : err});
                  }
                });
              }
            });

            pollQueueCallback ();
            winston.doInfo ('Finished downloading for user', {userEmail : user.email});
          }

        });
      }

      // function needed to passthrough arguments
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
    {$set : {nodeId : mikeymailConstants.MY_NODE_ID, mikeyMailTS : Date.now()}},
    function (err, updatedState) {
    if (err) {
      callback (winston.makeMongoError (err));
    }
    else if (!updatedState) {
      winston.doWarn ('onboarding state not found with attributes: ', {_id : foundState._id, nodeId : foundState.nodeId} );
      callback ();
    }
    else {
      callback (null, updatedState);
    }
  });

};
