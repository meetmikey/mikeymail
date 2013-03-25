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

var UserOnboardingStateModel = mongoose.model ('UserOnboardingState')
var setTimestampIntervalIds = {};
var mailDownloadDaemon = this;

exports.start = function () {
  winston.info ('starting mail download daemon')

  sqsConnect.pollMailDownloadQueue(function (message, pollQueueCallback) {

    console.log ('mail download daemon got poll queue message', message)
    var userInfo = JSON.parse (message);
    var xoauthParams = daemonUtils.getXOauthParams (userInfo);
    var xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);

    UserOnboardingStateModel.findOne ({'userId' : userInfo._id}, function (err, foundState) {
      var ISORestartTime = new Date(Date.now() - constants.ONBOARDING_TIMESTAMP_UPDATE_INTERVAL * constants.ONBOARDING_TIMESTAMP_RECLAIM_FACTOR).toISOString();

      if (err) {
        winston.doError ('Error looking up onboarding state', err)
      }
      else if (!foundState) {

        // mark new state object
        var state = new UserOnboardingStateModel({
          userId : userInfo._id,
          lastCompleted : 'gmailScrapeDequeued',
          nodeId : constants.MY_NODE_ID,
          mikeyMailTS : Date.now()
        })

        state.save (function (err) {
          if (err) {
            winston.doError('Error: could not save state for user ' + userInfo._id, err);
          }
          else {
            mailDownloadDaemon.scrapeMailbox (state._id, xoauth2gen, userInfo, pollQueueCallback)

            mongoPoll.setWorkingTimestampLoop (UserOnboardingStateModel,
              constants.ONBOARDING_TIMESTAMP_UPDATE_INTERVAL,
              state._id,
              function (err, intervalId) {
                if (err) { 
                  winston.handleError (err);
                }
                else {
                  setTimestampIntervalIds [String(userInfo._id)] = intervalId;
                }
              });
       
          }
        })

      }
      else if (foundState && foundState.lastCompleted== 'markStoppingPoint') {
        // message shouldn't be on queue onboarding complete
        pollQueueCallback();
      }
      else if (foundState && 
        foundState.nodeId && 
        foundState.mikeyMailTS.toISOString() < ISORestartTime) {

        winston.doInfo ('New node picking up and attempting to cliam foundState', {ISORestartTime: ISORestartTime, userEmail : userInfo.email});

        // the onboarding was claimed, but the node that claimed it hasn't updated the work state
        // for factor times the expected time, claim this state for yourself and start worknig again under
        // the assumption that the node is dead
        mailDownloadDaemon.attemptToClaimOnboardingState (foundState, function (err, updatedState) {
          if (err) {
            winston.handleError (err);
          }
          else if (!updatedState) {
            winston.doWarn ('Onboarding state already claimed by different node');
          }
          else {
            mailDownloadDaemon.scrapeMailbox (foundState._id, xoauth2gen, userInfo, pollQueueCallback, foundState);
          }
        });
      }
      else {
        winston.info ('User onboarding previously started and threshold not high enough to restart', 
          {state : JSON.stringify(foundState), restartTime : ISORestartTime});
      }
    })


  }, constants.MAX_DOWNLOAD_JOBS)

}

/*
 * Performs initial onboarding for user
 *
 * Parameters:
 * onboardingStateId = id database record that keeps track of onboarding progression of user
 * userInfo = user data pulled from queue
 * pollQueueCallback = callback to be invoked when you want to delete message from queue
 * lastCompleted = optional parameter that represents onboarding already in progress object in db
 */
exports.scrapeMailbox = function (onboardingStateId, xoauth2gen, userInfo, pollQueueCallback, foundState) {
  winston.info ('scrapeMailbox for user: ' +  userInfo.email);

  var lastCompleted;

  if (foundState) {
    lastCompleted = foundState.lastCompleted;
  }


  xoauth2gen.getToken(function(err, token) {
    if(err){
      winston.doError('Error: could not generate xoauth token', {error : err, userEmail : userInfo.email});

      // clear update interval
      mongoPoll.clearTimeIntervalLoop (userInfo._id, setTimestampIntervalIds, 'downloadDaemon');
      return;
    }
   
    // connect to imap server
    var myConnection = imapConnect.createImapConnection (userInfo.email, token)
    
    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {

      if (err) {
        winston.doError ('Error: Could not open mailbox', {error : err, userEmail : userInfo.email});

        // clear update interval
        mongoPoll.clearTimeIntervalLoop (userInfo._id, setTimestampIntervalIds, 'downloadDaemon');
        return;
      }

      winston.info ('Connection opened for user: ' + userInfo.email)
      winston.info ('Mailbox opened', mailbox)

      var operations = [
        startAsync,
        daemonUtils.createOrLookupMailbox,
        daemonUtils.retrieveHeadersInBatch,
        daemonUtils.mapReduceContacts,
        daemonUtils.mapReduceReceiveCounts,
        daemonUtils.markMarketingFromEmails,
        daemonUtils.markMarketingTextEmails,
        daemonUtils.retrieveEmails,
        daemonUtils.markStoppingPoint
      ]

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
      }


      if (lastCompleted) {
        var opLen = operations.length;

        // this user has already been onboarded to completion, no reason to continue
        if (lastCompleted == operations[opLen-1].name) {
          return pollQueueCallback ();
        }
        else {
          for (var i = 0; i < opLen; i++) {
            var operation = operations[i];

            if (operation.name == lastCompleted) {
              argDict.recoveryModeStartPoint = operations[i+1].name;
              argDict.recoveryMode = true;
              argDict.totalBandwith = foundState.bandwith;
              winston.info ('new starting point ' + operations[i+1].name);
              break;
            }

          }
        }
      }

      async.waterfall (operations, function (err) {

        winston.info ('waterfall callback');

        if (err) {
          winston.doError ('Could not finish downloading', err)
          pollQueueCallback(err);
          mongoPoll.clearTimeIntervalLoop (userInfo._id, setTimestampIntervalIds, 'downloadDaemon');
          daemonUtils.updateErrorState (onboardingStateId, err)
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

            mongoPoll.clearTimeIntervalLoop (userInfo._id, setTimestampIntervalIds, 'downloadDaemon');

          })

          pollQueueCallback ();
          winston.doInfo ('Finished downloading for user ' + {userEmail : userInfo.email});
        }

      });

      function startAsync (callback) {
        callback (null, argDict)
      }

    })
  })
}

exports.attemptToClaimOnboardingState = function (foundState, callback) {

  var findAttributes = {
    _id : foundState._id, 
    nodeId : foundState.nodeId
  }

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

      // set update loop for current node
      mongoPoll.setWorkingTimestampLoop (UserOnboardingStateModel,
        constants.ONBOARDING_TIMESTAMP_UPDATE_INTERVAL,
        foundState._id,
        function (err, intervalId) {
          if (err) { 
            winston.handleError (err);
          }
          else if (intervalId) {
            setTimestampIntervalIds [String(foundState.userId)] = intervalId;
          }
        });
    }
  });

}