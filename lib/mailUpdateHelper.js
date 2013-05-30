var serverCommon = process.env.SERVER_COMMON;

//TODO: fix imports
var constants = require ('../constants'),
    imapConnect = require ('./imapConnect'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    async = require ('async'),
    daemonUtils = require ('./daemonUtils');

var mailUpdateHelper = this;

exports.establishConnectionAndUpdate = function (user, xoauth2gen, pollQueueCallback) {
  xoauth2gen.getToken(function(err, token) {
    if(err){
      winston.doError('Error: could not generate xoauth token', {error: err});
      return;
    }
   
    // connect to imap server
    var myConnection = imapConnect.createImapConnection (user.email, token)
    
    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {

      if (err) {
        winston.addExtra( err, {userId : user._id, userEmail : user.email} );
        winston.handleError(err);
        return;
      }

      winston.doInfo('Connection opened for user: ' + user.email);
      mailUpdateHelper.updateMailbox (user, myConnection, mailbox, 0, pollQueueCallback);
    })

  })
}

/*
 * Updates mailbox for user
 *
 * Parameters:
 * user = user data pulled from queue
 * pollQueueCallback = callback to be invoked when you want to delete message from queue
 * myConnection = imap connection with mailbox opened
 */
exports.updateMailbox = function (user, myConnection, mailbox, numNew, callback) {

  winston.doInfo('updateMailbox', {
    userEmail : user.email, 
    userId : user._id, 
    numNew : numNew
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

  var currentTime = Date.now();

  // all variables needed by async waterfall are passed in this object
  var argDict = {
    'userId' : user._id,
    'userEmail' : user.email,
    'isOnboarding' : false,
    'myConnection' : myConnection,
    'totalBandwith' : 0,
    'numNew' : numNew,
    'mailbox' : mailbox,
    'isUpdate' : true,
    'isPremium' : user.isPremium,
    'minProcessedDate' : user.minProcessedDate,
    'minDateToProcess' : new Date(currentTime - user.daysLimit*constants.ONE_DAY_IN_MS)
  }

  async.waterfall (operations, function (err) {

    if (err && !err.warning) {
      winston.doError ('Could not finish updating', err);
      callback (err);
    }
    else {
      winston.doInfo('closing mailbox ' + user.email);
      // close the mailbox
      imapConnect.closeMailbox (myConnection, function (err) {
        if (err) {
          winston.doError ('Could not close mailbox', {err : err, user : user})
          callback (err)
        }
        else {
          winston.doInfo('mailbox closed for user ' + user.email);
          callback ();
        }
      });
    }

  })

  function startAsync (callback) {
    callback (null, argDict)
  }

}