//TODO: fix imports
var constants = require ('../constants'),
    imapConnect = require ('./imapConnect'),
    imapRetrieve = require ('./imapRetrieve'),
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    fs = require ('fs'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    conf = require (constants.SERVER_COMMON + '/conf'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    async = require ('async'),
    xoauth2 = require("xoauth2"),
    mongoPoll = require ('./mongoPoll'),
    daemonUtils = require ('./daemonUtils');

var MailBox = mongoose.model ('MailBox');
var MailModel = mongoose.model ('Mail');
var UserModel = mongoose.model ('User');
var UserOnboardingStateModel = mongoose.model ('UserOnboardingState');

var mailResumeDownloadDaemon = this;

exports.start = function () {
  winston.info ('starting mail resume download daemon');

  // poll mongo, trigger intiial downloading waterfall at attachments step
  mongoPoll.startPollingResumeDownload(function (err, foundResumeTask) {

    if (err || !foundResumeTask) {
      winston.info ('no new resume state found')
    }
    else {
      UserModel.findById (foundResumeTask.userId, function (err, foundUser) {
        if (err) {
          winston.doError ('could not find user in db to resumeDownloading', {userId : foundResumeTask.userId, err : err});
        }
        else if (!foundUser) {
          winston.doError ('could not find user in db to resumeDownloading', {userId : foundResumeTask.userId, err : err});
        }
        else {
          var userId = foundUser._id

          var xoauthParams = daemonUtils.getXOauthParams (foundUser);
          var xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);

          xoauth2gen.getToken(function(err, token) {
            if(err){
              winston.doError('Error: could not generate xoauth token', {error: err})
              return
            }
           
            // connect to imap server
            var myConnection = imapConnect.createImapConnection (foundUser.email, token);
            
            // open mailbox
            imapConnect.openMailbox (myConnection, function (err, mailbox) {

              if (err) {
                winston.doError ('Error: could not open mailbox', {error : err});
                return;
              }

              winston.info ('Connection opened for user: ' + foundUser.email);
              winston.info ('Mailbox opened', mailbox);

              mailResumeDownloadDaemon.resumeDownloading (foundUser, myConnection, mailbox, foundResumeTask, 
                function () {
                  mongoPoll.decrementResumesInProgress();
                });
            });
          });
        }
      });
    }

  });
}

/*
 * Updates mailbox for user
 *
 * Parameters:
 * userInfo = user data pulled from queue
 * pollQueueCallback = callback to be invoked when you want to delete message from queue
 * myConnection = imap connection with mailbox opened
 */
exports.resumeDownloading = function (userInfo, myConnection, mailbox, foundResumeTask, pollMongoCallback) {

  var operations = [
    startAsync,
    daemonUtils.lookupMailbox,
    daemonUtils.createTempDirectoryForEmails,
    daemonUtils.retrieveAttachments,
    daemonUtils.retrieveEmailsNoAttachments,
    daemonUtils.markStoppingPoint
  ]

  // all variables needed by async waterfall are passed in this object
  var argDict = {
    'userId' : userInfo._id,
    'userEmail' : userInfo.email,
    'isOnboarding' : false,
    'myConnection' : myConnection,
    'isResumeDownloading' : true,
    'resumeDownloadingId' : foundResumeTask._id,
    'attachmentBandwith' : 0,
    'otherBandwith' : 0,
    'totalBandwith' : 0,
    'maxUid' : foundResumeTask.maxUid,
    'mailbox' : mailbox
  }

  async.waterfall (operations, function (err) {

    if (err) {
      winston.doError ('Could not finish updating', err);
    }
    else {
      // close the mailbox
      imapConnect.closeMailbox (myConnection, function (err) {
        if (err) {
          winston.doError ('Could not close mailbox', err);
        }
        else {
          winston.info ('mailbox closed for user ' + userInfo.email);
        }
      })

      pollMongoCallback ();
      winston.info ('Finished updating for user ' + userInfo.email);
    }

  })

  function startAsync (callback) {
    callback (null, argDict);
  }

}