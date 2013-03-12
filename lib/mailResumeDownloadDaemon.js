//TODO: fix imports
var constants = require ('../constants'),
    imapConnect = require ('./imapConnect'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    async = require ('async'),
    xoauth2 = require("xoauth2"),
    mongoPoll = require ('./mongoPoll'),
    daemonUtils = require ('./daemonUtils');

var UserModel = mongoose.model ('User');

var mailResumeDownloadDaemon = this;

exports.start = function () {
  winston.info ('starting mail resume download daemon');

  // poll mongo, trigger intiial downloading waterfall at attachments step
  mongoPoll.startPollingResumeDownload(function (err, foundResumeTask) {
    console.log ('foundResumeTask in the callback', foundResumeTask);
    if (err || !foundResumeTask) {
      winston.info ('no new resume state found');
    }
    else {
      winston.info ('got a task to resume downloading', {resumeId : foundResumeTask._id});
      UserModel.findById (foundResumeTask.userId, function (err, foundUser) {
        if (err) {
          winston.doError ('could not find user in db to resumeDownloading', {userId : foundResumeTask.userId, err : err});
        }
        else if (!foundUser) {
          winston.doError ('could not find user in db to resumeDownloading', {userId : foundResumeTask.userId, err : err});
        }
        else {

          var xoauthParams = daemonUtils.getXOauthParams (foundUser);
          var xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);

          xoauth2gen.getToken(function(err, token) {
            if(err){
              winston.doError('Error: could not generate xoauth token', {error: err});
              return;
            }
            winston.info ('resume download got token');
            // connect to imap server
            var myConnection = imapConnect.createImapConnection (foundUser.email, token);
            
            // open mailbox
            imapConnect.openMailbox (myConnection, function (err, mailbox) {
              if (err) {
                winston.doError ('Error: could not open mailbox', {error : err, userId : foundUser._id, userEmail : foundUser.email});
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
};

/*
 * Updates mailbox for user
 *
 * Parameters:
 * userInfo = user data pulled from queue
 * pollQueueCallback = callback to be invoked when you want to delete message from queue
 * myConnection = imap connection with mailbox opened
 */
exports.resumeDownloading = function (userInfo, myConnection, mailbox, foundResumeTask, pollMongoCallback) {

  winston.info ('call resume downloading', {user : userInfo});

  var operations = [
    startAsync,
    daemonUtils.lookupMailbox,
    daemonUtils.retrieveAttachments,
    daemonUtils.retrieveEmailsNoAttachments,
    daemonUtils.markStoppingPoint
  ];

  // all variables needed by async waterfall are passed in this object
  var argDict = {
    'userId' : userInfo._id,
    'userEmail' : userInfo.email,
    'isOnboarding' : false,
    'myConnection' : myConnection,
    'isResumeDownloading' : true,
    'isUpdate' : false,
    'resumeDownloadingId' : foundResumeTask._id,
    'attachmentBandwith' : 0,
    'otherBandwith' : 0,
    'totalBandwith' : 0,
    'maxUid' : foundResumeTask.maxUid,
    'mailbox' : mailbox
  };

  async.waterfall (operations, function (err) {

    if (err) {
      winston.doError ('ResumeDownload: Could not finish updating', err);
    }
    else {
      // close the mailbox
      imapConnect.closeMailbox (myConnection, function (err) {
        if (err) {
          winston.doError ('ResumeDownload: Could not close mailbox', {err : err, userId : userInfo._id, userEmail : userInfo.email});
        }
        else {
          winston.doInfo ('mailbox closed for user ', {userEmail : userInfo.email});
        }
      });

      pollMongoCallback ();
      winston.info ('ResumeDownload: Finished updating for user ' + userInfo.email);
    }

  });

  function startAsync (callback) {
    callback (null, argDict);
  }

};