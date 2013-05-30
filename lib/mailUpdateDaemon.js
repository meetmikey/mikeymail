var serverCommon = process.env.SERVER_COMMON;

//TODO: fix imports
var constants = require ('../constants'),
    imapConnect = require ('./imapConnect'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    async = require ('async'),
    daemonUtils = require ('./daemonUtils');

var mailUpdateDaemon = this;

exports.start = function () {
  winston.doInfo('starting mail update daemon')

  //TODO: refactor this... update based on db every 1 hour? even for logged out/idle user
}


exports.establishConnectionAndUpdate = function (userInfo, xoauth2gen, pollQueueCallback) {
  xoauth2gen.getToken(function(err, token) {
    if(err){
      winston.doError('Error: could not generate xoauth token', {error: err});
      return;
    }
   
    // connect to imap server
    var myConnection = imapConnect.createImapConnection (userInfo.email, token)
    
    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {

      if (err) {
        winston.addExtra( err, {userId : userInfo._id, userEmail : userInfo.email} );
        winston.handleError(err);
        return;
      }

      winston.doInfo ('Connection opened for user: ' + userInfo.email)
      winston.doInfo ('Mailbox opened', mailbox)

      var isInitialConnectUpdate = true;
      var keepMailboxOpen = false;

      mailUpdateDaemon.updateMailbox (userInfo, myConnection, mailbox, 0, isInitialConnectUpdate, keepMailboxOpen, pollQueueCallback);
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
exports.updateMailbox = function (userInfo, myConnection, mailbox, numNew, isInitialConnectUpdate, keepMailboxOpen, callback) {

  winston.doInfo ('updateMailbox', {
    userEmail : userInfo.email, 
    userId : userInfo._id, 
    numNew : numNew,
    keepMailboxOpen : keepMailboxOpen, 
    isInitialConnectUpdate : isInitialConnectUpdate
  });

  var operations = [
    startAsync,
    daemonUtils.lookupMailbox,
    daemonUtils.retrieveHeaders,
    daemonUtils.mapReduceContacts,
    daemonUtils.mapReduceReceiveCounts,
    daemonUtils.markAttachments,
    daemonUtils.markMarketingFromEmails,
    daemonUtils.markMarketingTextEmails,
    daemonUtils.retrieveEmails,
    daemonUtils.updateMailbox
  ]

  // all variables needed by async waterfall are passed in this object
  var argDict = {
    'userId' : userInfo._id,
    'userEmail' : userInfo.email,
    'isOnboarding' : false,
    'myConnection' : myConnection,
    'totalBandwith' : 0,
    'numNew' : numNew,
    'mailbox' : mailbox,
    'isUpdate' : true,
    'isInitialConnectUpdate' : isInitialConnectUpdate
  }

  async.waterfall (operations, function (err) {

    if (err && !err.warning) {
      winston.doError ('Could not finish updating', err);
      callback (err);
    }
    else {
      if (!keepMailboxOpen) {
        
        winston.doInfo('closing mailbox ' + userInfo.email);
        // close the mailbox
        imapConnect.closeMailbox (myConnection, function (err) {
          if (err) {
            winston.doError ('Could not close mailbox', {err : err, user : userInfo})
            callback (err)
          }
          else {
            winston.doInfo('mailbox closed for user ' + userInfo.email)
            callback ();
          }
        })
      }
      else {
        winston.doInfo ('done updating mailbox ' + userInfo.email);
        callback ();
      }
    }

  })

  function startAsync (callback) {
    callback (null, argDict)
  }

}