var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants'),
    imapConnect = require ('./imapConnect'),
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose,
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    async = require ('async'),
    xoauth2 = require("xoauth2"),
    mongoPoll = require ('./mongoPoll'),
    daemonUtils = require ('./daemonUtils');

var UserModel = mongoose.model ('User');
var ResumeDownloadStateModel = mongoose.model ('ResumeDownloadState');

var mailResumeDownloadDaemon = this;
var myTimestampLoops = {};

exports.start = function () {
  winston.info ('starting mail resume download daemon');

  // poll mongo, trigger intiial downloading waterfall at attachments step
  mongoPoll.startPollingResumeDownload(function (err, foundResumeTask) {
    if (err) {
      winston.handleError (err);
    }
    else if (!foundResumeTask) {
      winston.doInfo ('No accounts to resume downloading for');
    }
    else {
      winston.doInfo ('Got a task to resume downloading', {resumeId : foundResumeTask._id});

      UserModel.findById (foundResumeTask.userId, function (err, foundUser) {
        if (err) {
          winston.doMongoError ('error looking up user', {userId : foundResumeTask.userId, err : err});
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

            // connect to imap server
            var myConnection = imapConnect.createImapConnection (foundUser.email, token);
            
            // open mailbox
            imapConnect.openMailbox (myConnection, function (err, mailbox) {
              if (err) {
                winston.handleError (err);
                winston.doError ('Error: could not open mailbox', {error : err, userId : foundUser._id, userEmail : foundUser.email});
                return;
              }

              // set working state loop on resume task in db
              mongoPoll.setWorkingTimestampLoop (ResumeDownloadStateModel,
                constants.RESUME_DOWNLOAD_TIMESTAMP_INTERVAL,
                foundResumeTask._id,
                function (err, intervalId) {
                  if (err) { 
                    winston.handleError (err);
                  }
                  else {
                    mongoPoll.setTimestampInterval (foundResumeTask.userId, intervalId, myTimestampLoops);
                  }
                });

              winston.doInfo ('Connection opened for user: ', {email : foundUser.email});

              mailResumeDownloadDaemon.resumeDownloading (foundUser, myConnection, mailbox, foundResumeTask, 
                function (err) {
                  if (err) {
                    winston.handleError (err);
                    // TODO: mark error in db?
                  }

                  mongoPoll.clearTimeIntervalLoop (foundResumeTask.userId, myTimestampLoops, 'resumeDownloadDaemon');
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
 * pollMongoCallback = callback to be invoked when finished with the task
 * myConnection = imap connection with mailbox opened
 */
exports.resumeDownloading = function (userInfo, myConnection, mailbox, foundResumeTask, pollMongoCallback) {

  winston.doInfo ('call resume downloading', {user : userInfo});

  // all variables needed by async waterfall are passed in this object
  var argDict = {
    'userId' : userInfo._id,
    'userEmail' : userInfo.email,
    'isOnboarding' : false,
    'myConnection' : myConnection,
    'isResumeDownloading' : true,
    'isUpdate' : false,
    'resumeDownloadingId' : foundResumeTask._id,
    'totalBandwith' : foundResumeTask.bandwith,
    'maxUid' : foundResumeTask.maxUid,
    'mailbox' : mailbox
  };

  var operations = [
    startAsync,
    daemonUtils.lookupMailbox,
    daemonUtils.retrieveEmails,
    daemonUtils.markStoppingPoint
  ];

  var lastCompleted = foundResumeTask.lastCompleted;

  // recovery mode in this case doesn't matter since only 3 tasks exist...
  // which all have to be done no matter whether we're recovering or handling
  // the resume task for the first time. However, we observe the bandwith consumed
  // in the previous task
  if (lastCompleted) {
    argDict.totalBandwith = foundResumeTask.bandwith;
  }

  async.waterfall (operations, function (err) {

    if (err) {
      pollMongoCallback (winston.makeError ('ResumeDownload: Could not finish updating', {err : err}));
    }
    else {

      winston.doInfo ('ResumeDownload: Finished updating for user ', {userEmail :userInfo.email});

      // close the mailbox
      imapConnect.closeMailbox (myConnection, function (err) {
        if (err) {
          winston.doError ('ResumeDownload: Could not close mailbox', {err : err, userId : userInfo._id, userEmail : userInfo.email});
        }
        else {
          winston.doInfo ('ResumeDownload: mailbox closed for user ', {userEmail : userInfo.email});
        }
      });

      pollMongoCallback ();
    }

  });

  function startAsync (callback) {
    callback (null, argDict);
  }

};