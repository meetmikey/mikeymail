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
            scrapeMailbox (state._id, xoauth2gen, userInfo, pollQueueCallback)

           mongoPoll.setWorkingTimestampLoop (UserOnboardingStateModel,
              constants.ONBOARDING_TIMESTAMP_UPDATE_INTERVAL,
              state._id,
              function (err, intervalId) {
                if (err) { 
                  winston.handleError (err);
                }
                else {
                  setTimestampIntervalIds [userInfo._id] = intervalId;
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
        foundState.mikeyMailTS < Date.now() - constants.ONBOARDING_TIMESTAMP_UPDATE_INTERVAL * constants.ONBOARDING_TIMESTAMP_RECLAIM_FACTOR) {
        // the onboarding was claimed, but the node that claimed it hasn't updated the work state
        // for factor times the expected time, claim this state for yourself and start worknig again under
        // the assumption that the node is dead

        // TODO: TEST THIS
        mailDownloadDaemon.claimOnboardingState (foundState);

        scrapeMailbox (foundState._id, xoauth2gen, userInfo, pollQueueCallback, foundState.lastCompleted);

      }
      else {
        winston.info ('User onboarding previously started and threshold not high enough to restart', JSON.stringify(foundState));
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
 * lastCompleted = optional parameter that represents last completed state if onboarding previously aborted
 */
function scrapeMailbox (onboardingStateId, xoauth2gen, userInfo, pollQueueCallback, lastCompleted) {
  winston.info ('scrapeMailbox for user: ' +  userInfo.email);
  xoauth2gen.getToken(function(err, token) {
    if(err){
      winston.doError('Error: could not generate xoauth token', {error : err});
      return;
    }
   
    // connect to imap server
    var myConnection = imapConnect.createImapConnection (userInfo.email, token)
    
    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {

      if (err) {
        winston.doError ('Error: Could not open mailbox', {error : err});
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
        daemonUtils.createTempDirectoryForEmails,
        daemonUtils.markMarketingFromEmails,
        daemonUtils.markMarketingTextEmails,
        daemonUtils.retrieveAttachments,
        daemonUtils.retrieveEmailsNoAttachments,
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
        'attachmentBandwith' : 0,
        'otherBandwith' : 0,
        'totalBandwith' : 0,
        'mailbox' : mailbox,
        'recoveryMode' : false,
        'recoveryModeStartPoint' : 'startAsync',
        'isUpdate' : false
      }


      if (lastCompleted) {
        var opLen = operations.length

        // this user has already been onboarded to completion, no reason to continue
        if (lastCompleted == operations[opLen-1].name) {
          return pollQueueCallback ()
        }
        else {
          for (var i = 0; i < opLen; i++) {
            var operation = operations[i]

            if (operation.name == lastCompleted) {
              argDict.recoveryModeStartPoint = operations[i+1].name
              argDict.recoveryMode = true
              winston.info ('new starting point ' + operations[i+1].name)
              break
            }

          }
        }
      }

      async.waterfall (operations, function (err) {

        winston.info ('waterfall callback');

        if (err) {
          winston.doError ('Could not finish downloading', err)
          pollQueueCallback(err);
          daemonUtils.updateErrorState (onboardingStateId, err)
        }
        else {
          // close the mailbox
          imapConnect.closeMailbox (myConnection, function (err) {
            if (err) {
              winston.doError ('Could not close mailbox', err)
            }
            else {
              winston.info ('mailbox closed for user ' + userInfo.email)
            }

            if (!setTimestampIntervalIds [userInfo._id]) {
              winston.doError ('No setTimestampIntervalIds for key', {userId : userInfo._id});
            }


            console.log ('timestamp interval ids', setTimestampIntervalIds);

            winston.doInfo ('done with initial indexing, \
              clearing interval to update mongo timestamp', 
              {userId : userInfo._id, intervalId : setTimestampIntervalIds [userInfo._id]}); // TODO: check undefined intervalId
            
            clearInterval (setTimestampIntervalIds [userInfo._id]);
            delete setTimestampIntervalIds [userInfo._id];

          })

          pollQueueCallback ()
          winston.info ('Finished downloading for user ' + userInfo.email)
        }

      })

      function startAsync (callback) {
        callback (null, argDict)
      }

    })
  })
}


exports.claimOnboardingState = function (foundState){

  foundState.nodeId = constants.MY_NODE_ID;
  foundState.mikeyMailTS = Date.now();
  foundState.save (function (err) {
    if (err) {
      winston.doError ('Error: could not set nodeId: ', {error : err});
    }
    else {
      mongoPoll.setWorkingTimestampLoop (UserOnboardingStateModel,
        constants.ONBOARDING_TIMESTAMP_UPDATE_INTERVAL,
        foundState._id,
        function (err, intervalId) {
          if (err) { 
            winston.handleError (err);
          }
          else if (intervalId) {
            console.log ('intervalId', intervalId)
            setTimestampIntervalIds [foundState.userId] = intervalId;
            console.log (setTimestampIntervalIds);
          }
        });
    }
  });

}