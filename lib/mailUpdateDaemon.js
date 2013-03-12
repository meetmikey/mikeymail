//TODO: fix imports
var constants = require ('../constants'),
    imapConnect = require ('./imapConnect'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    async = require ('async'),
    daemonUtils = require ('./daemonUtils');

var mailUpdateDaemon = this;

exports.start = function () {
  winston.info ('starting mail update daemon')

  //TODO: refactor this... update based on db every 1 hour? even for logged out/idle user

  /*
  sqsConnect.pollMailUpdateQueue(function (message, pollQueueCallback) {

    console.log ('got poll queue message', message)
    var userInfo = JSON.parse (message)
    var userId = userInfo._id

    var xoauthParams = daemonUtils.getXOauthParams (userInfo);

    console.log (userInfo.expiresAt)

    if (userInfo.accessToken
        && (userInfo.expiresAt && userInfo.expiresAt < Date.now() - constants.ACCESS_TOKEN_UPDATE_TIME_BUFFER)) {
      xoauthParams.accessToken = userInfo.accessToken
    }

    var xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);

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
exports.updateMailbox = function (userInfo, myConnection, mailbox, numNew, keepMailboxOpen, callback) {

  var operations = [
    startAsync,
    daemonUtils.lookupMailbox,
    daemonUtils.retrieveHeaders,
    daemonUtils.mapReduceContacts,
    daemonUtils.mapReduceReceiveCounts,
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

    if (err && !err.warning) {
      winston.doError ('Could not finish updating', err);
      callback (err);
    }
    else {
      if (!keepMailboxOpen) {
        
        winston.info ('closing mailbox ' + userInfo.email);
        // close the mailbox
        imapConnect.closeMailbox (myConnection, function (err) {
          if (err) {
            winston.doError ('Could not close mailbox', {err : err, user : userInfo})
            callback (err)
          }
          else {
            winston.info ('mailbox closed for user ' + userInfo.email)
            callback ();
          }
        })
      }
      else {
        winston.info ('done updating mailbox ' + userInfo.email);
        callback ();
      }
    }

  })

  function startAsync (callback) {
    callback (null, argDict)
  }

}