//TODO: fix imports
var constants = require ('../constants'),
    imapConnect = require ('./imapConnect'),
    imapRetrieve = require ('./imapRetrieve'),
    knox = require (constants.SERVER_COMMON + '/lib/s3Utils').client,
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    fs = require ('fs'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    conf = require (constants.SERVER_COMMON + '/conf'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    async = require ('async'),
    xoauth2 = require("xoauth2"),
    daemonUtils = require ('./daemonUtils');

var MailBox = mongoose.model ('MailBox')
var MailModel = mongoose.model ('Mail')
var UserOnboardingStateModel = mongoose.model ('UserOnboardingState')

var mailUpdateDaemon = this;

exports.start = function () {
  winston.info ('starting mail update daemon')

  /*
  sqsConnect.pollMailUpdateQueue(function (message, pollQueueCallback) {

    console.log ('got poll queue message', message)
    var userInfo = JSON.parse (message)
    var userId = userInfo._id

    var xoauthParams = {
      user: userInfo.email,
      clientId: conf.google.appId,
      clientSecret: conf.google.appSecret,
      refreshToken: userInfo.refreshToken      
    }

    console.log (userInfo.expiresAt)

    if (userInfo.accessToken
        && (userInfo.expiresAt && userInfo.expiresAt < Date.now() - constants.ACCESS_TOKEN_UPDATE_TIME_BUFFER)) {
      xoauthParams.accessToken = userInfo.accessToken
    }

    xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);

    mailUpdateDaemon.establishConnectionAndUpdate (userInfo, xoauth2gen, pollQueueCallback)

  }, constants.MAX_UPDATE_JOBS)
  */

  

}


exports.establishConnectionAndUpdate = function (userInfo, xoauth2gen, pollQueueCallback) {
  xoauth2gen.getToken(function(err, token) {
    if(err){
      winston.doError('Error: could not generate xoauth token', {error: err})
      return
    }
   
    // connect to imap server
    var myConnection = imapConnect.createImapConnection (userInfo.email, token)
    
    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {

      if (err) {
        winston.doError ('Error: could not open mailbox', {error : err})
        return
      }

      winston.info ('Connection opened for user: ' + userInfo.email)
      winston.info ('Mailbox opened', mailbox)

      mailUpdateDaemon.updateMailbox (userInfo, myConnection, mailbox, 0, keepMailboxOpen=false, pollQueueCallback)
    })

  })
}

/*
 * Updates mailbox for user
 *
 * Parameters:
 * userInfo = user data pulled from queue
 * pollQueueCallback = callback to be invoked when you want to delete message from queue
 * myConnection = imap connection with mailbox opened
 */
exports.updateMailbox = function (userInfo, myConnection, mailbox, numNew, keepMailboxOpen, pollQueueCallback) {

  var operations = [
    startAsync,
    daemonUtils.lookupMailbox,
    daemonUtils.retrieveHeaders,
    daemonUtils.mapReduceContacts,
    daemonUtils.mapReduceReceiveCounts,
    daemonUtils.createTempDirectoryForEmails,
    daemonUtils.markMarketingFromEmails,
    daemonUtils.markMarketingTextEmails,
    daemonUtils.retrieveAttachments,
    daemonUtils.retrieveEmailsNoAttachments,
    daemonUtils.updateMailbox
  ]

  // all variables needed by async waterfall are passed in this object
  var argDict = {
    'userId' : userInfo._id,
    'userEmail' : userInfo.email,
    'isOnboarding' : false,
    'myConnection' : myConnection,
    'attachmentBandwith' : 0,
    'otherBandwith' : 0,
    'totalBandwith' : 0,
    'numNew' : numNew,
    'mailbox' : mailbox,
    'isUpdate' : true
  }

  async.waterfall (operations, function (err) {

    if (err) {
      winston.doError ('Could not finish updating', err)
    }
    else {
      if (!keepMailboxOpen) {
        // close the mailbox
        imapConnect.closeMailbox (myConnection, function (err) {
          if (err) {
            winston.doError ('Could not close mailbox', err)
          }
          else {
            winston.info ('mailbox closed for user ' + userInfo.email)
          }
        })
      }

      pollQueueCallback ()
      winston.info ('Finished updating for user ' + userInfo.email)
    }

  })

  function startAsync (callback) {
    callback (null, argDict)
  }

}