var constants = require ('../constants'),
    imapConnect = require ('./imapConnect'),
    imapRetrieve = require ('./imapRetrieve'),
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    conf = require (constants.SERVER_COMMON + '/conf'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    async = require ('async'),
    xoauth2 = require("xoauth2"),
    daemonUtils = require ('./daemonUtils');

var MailBox = mongoose.model ('MailBox')
var MailModel = mongoose.model ('Mail')
var UserOnboardingStateModel = mongoose.model ('UserOnboardingState')

exports.start = function () {
  winston.info ('starting mail download daemon')

  sqsConnect.pollMailDownloadQueue(function (message, pollQueueCallback) {

    console.log ('got poll queue message', message)
    var userInfo = JSON.parse (message)
    var userId = userInfo._id
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
          lastCompleted : 'gmailScrapeDequeued'
        })

        state.save (function (err) {
          if (err) {
            winston.doError('Error: could not save state for user ' + userInfo._id, err);
          }
          else {
            scrapeMailbox (state._id, xoauth2gen, userInfo, pollQueueCallback)
          }
        })

      }
      else {
        winston.info ('User onboarding previously started', JSON.stringify(foundState))
        scrapeMailbox (foundState._id, xoauth2gen, userInfo, pollQueueCallback, foundState.lastCompleted)
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

  xoauth2gen.getToken(function(err, token) {
    if(err){
      winston.doError('Error: could not generate xoauth token', err)
      return
    }
   
    // connect to imap server
    var myConnection = imapConnect.createImapConnection (userInfo.email, token)
    
    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {

      if (err) {
        winston.doError ('Error: Could not open mailbox', err)
        return
      }

      winston.info ('Connection opened for user: ' + userInfo.email)
      winston.info ('Mailbox opened', mailbox)

      var operations = [
        startAsync,
        daemonUtils.createOrLookupMailbox,
        daemonUtils.retrieveHeaders,
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

        if (err) {
          winston.doError ('Could not finish downloading', err)
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
