var serverCommon = process.env.SERVER_COMMON;

var mikeymailConstants = require ('../constants'),
    constants = require(serverCommon + '/constants'),
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
  winston.doInfo('starting mail resume download daemon');

  // poll mongo, trigger intiial downloading waterfall at attachments step
  mongoPoll.startPollingResumeDownload(function (foundResumeTask, doneWithTaskCallback) {
    winston.doInfo ('Got a task to resume downloading', {resumeId : foundResumeTask._id});

    UserModel.findById (foundResumeTask.userId, function (err, foundUser) {
      if (err) {
        doneWithTaskCallback (winston.makeMongoError (err), foundResumeTask, false);
      }
      else if (!foundUser) {
        doneWithTaskCallback (
          winston.makeError ('could not find user in db to resumeDownloading', {userId : foundResumeTask.userId, err : err}),
          foundResumeTask, true);
      }
      else if (foundUser.invalidToken) {
        doneWithTaskCallback (winston.makeError ('invalid token for user'), foundResumeTask, true);
      }
      else {

        var xoauthParams = daemonUtils.getXOauthParams (foundUser);
        var xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);

        xoauth2gen.getToken(function(err, token) {
          if(err){
            winston.doWarn('Warning: could not generate xoauth token', {error: err, userId : foundUser._id, email : foundUser.email});

            // invalid grant = token must be invalid      
            if (err == 'invalid_grant') {
              daemonUtils.updateUserTokenValidity (foundUser._id, function (updateErr) {
                if (updateErr) {
                  winston.handleError (updateErr);
                }
              });
              doneWithTaskCallback (winston.makeError ('invalid_grant', {err : err}), foundResumeTask, true);
            } 
            else {
              doneWithTaskCallback (winston.makeError ('could not generate xoauth token', {err : err}), foundResumeTask, false);
            }
          }
          else {

            // connect to imap server
            var myConnection = imapConnect.createImapConnection (foundUser.email, token);
            
            // open mailbox
            imapConnect.openMailbox (myConnection, function (err, mailbox) {
              if (err) {
                var errorType = winston.getErrorType (err);
                if (errorType === mikeymailConstants.ERROR_TYPE_ALL_MAIL_DOESNT_EXIST ||
                    errorType === mikeymailConstants.ERROR_TYPE_NO_BOX_TO_OPEN) {
                  
                  if (!foundUser.allMailError) {
                    daemonUtils.setUserAllMailError(false, foundUser, errorType, function (err) {
                      if (err) { 
                        doneWithTaskCallback (err, foundResumeTask, false);
                      } else {
                        doneWithTaskCallback (null, foundResumeTask, true);
                      }
                    });
                  }
                } else {
                  winston.addExtra( err, {userId : foundUser._id, userEmail : foundUser.email} );
                  doneWithTaskCallback (err, foundResumeTask, false);
                }
              } else {

                if (foundUser.allMailError) { daemonUtils.unSetUserAllMailError (foundUser); }

                // set working state loop on resume task in db
                mongoPoll.setWorkingTimestampLoop (ResumeDownloadStateModel,
                  mikeymailConstants.RESUME_DOWNLOAD_TIMESTAMP_INTERVAL,
                  foundResumeTask,
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
                    mongoPoll.clearTimeIntervalLoop (foundResumeTask.userId, myTimestampLoops, 'resumeDownloadDaemon');

                    if (err) {
                      doneWithTaskCallback (err, foundResumeTask, false);
                    } else {
                      doneWithTaskCallback (null, foundResumeTask, false);
                    }
                  });
              }
            });
          }
        });
      }
    });
  });
};



/*
 * Updates mailbox for user
 *
 * Parameters:
 * user = user data pulled from queue
 * pollMongoCallback = callback to be invoked when finished with the task
 * myConnection = imap connection with mailbox opened
 */
exports.resumeDownloading = function (user, myConnection, mailbox, foundResumeTask, pollMongoCallback) {

  winston.doInfo ('call resume downloading', {user : user});

  var currentTime = Date.now();

  // all variables needed by async waterfall are passed in this object
  var argDict = {
    'userId' : user._id,
    'userEmail' : user.email,
    'isOnboarding' : false,
    'myConnection' : myConnection,
    'isResumeDownloading' : true,
    'isUpdate' : false,
    'resumeDownloadingId' : foundResumeTask._id,
    'totalBandwith' : foundResumeTask.bandwith,
    'maxUid' : foundResumeTask.maxUid,
    'maxDate' : foundResumeTask.maxDate,
    'mailbox' : mailbox,
    'isPremium' : user.isPremium,
    'minProcessedDate' : user.minProcessedDate,
    'minDateAccount' : new Date(currentTime - user.daysLimit*constants.ONE_DAY_IN_MS),
    'minDate' : new Date(currentTime - user.daysLimit*constants.ONE_DAY_IN_MS)
  };

  var operations = [
    startAsync,
    daemonUtils.lookupMailbox,
    daemonUtils.getMoreHeadersForResume,
    daemonUtils.markAttachments,
    daemonUtils.markMarketingFromEmails,
    daemonUtils.markMarketingTextEmails,
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

      winston.doInfo ('ResumeDownload: Finished updating for user ', {userEmail :user.email});

      // close the mailbox
      imapConnect.closeMailbox (myConnection, function (err) {
        if (err) {
          winston.doError ('ResumeDownload: Could not close mailbox', {err : err, userId : user._id, userEmail : user.email});
        }
        else {
          winston.doInfo ('ResumeDownload: mailbox closed for user ', {userEmail : user.email});
        }
      });

      pollMongoCallback ();
    }

  });

  function startAsync (callback) {
    callback (null, argDict);
  }

};
