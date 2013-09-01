var serverCommon = process.env.SERVER_COMMON;

var mikeymailConstants = require ('../constants'),
    imapConnect = require ('./imapConnect'),
    sesUtils = require (serverCommon + '/lib/sesUtils'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    UserOnboardingStateModel = require(serverCommon + '/schema/onboard').UserOnboardingStateModel,
    ResumeDownloadStateModel = require(serverCommon + '/schema/onboard').ResumeDownloadStateModel,
    UserModel = require(serverCommon + '/schema/user').UserModel,
    googleUtils = require (serverCommon + '/lib/googleUtils'),
    async = require ('async'),
    xoauth2 = require("xoauth2"),
    mongoPoll = require ('./mongoPoll'),
    daemonUtils = require ('./daemonUtils');

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

        // get a fresh access token
        googleUtils.getAccessToken (foundUser._id, function (err, accessToken) {
          if (err) {
            return doneWithTaskCallback (err);
          }

          foundUser.accessToken = accessToken;

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
              imapConnect.openMailbox (myConnection, foundUser.email, function (err, mailbox) {
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
                  } 
                  else if (errorType === 'ECONNRESET' || errorType === 'ETIMEDOUT') {
                    winston.doWarn ('connection closed unexpectedly, clearing time interval loop for user', {email : foundUser.email});
                    mongoPoll.clearTimeIntervalLoop (foundResumeTask._id, myTimestampLoops, 'resumeDownloadDaemon');
                  }
                  else {
                    winston.addExtra( err, {userId : foundUser._id, userEmail : foundUser.email} );
                    doneWithTaskCallback (err, foundResumeTask, false);
                  }

                } 
                else {

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
                        mongoPoll.setTimestampInterval (foundResumeTask._id, intervalId, myTimestampLoops);
                      }
                    });

                  winston.doInfo ('Connection opened for user: ', {email : foundUser.email});

                  mailResumeDownloadDaemon.resumeDownloading (foundUser, myConnection, mailbox, foundResumeTask, 
                    function (err) {
                      mongoPoll.clearTimeIntervalLoop (foundResumeTask._id, myTimestampLoops, 'resumeDownloadDaemon');

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
        });
      } // end else
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

  UserOnboardingStateModel.findOne ({userId : user._id}, function (err, foundOnboardingState) {
    if (err) {
      pollMongoCallback (winston.makeMongoError (err));

    } else if (!foundOnboardingState) {
      pollMongoCallback (winston.makeError ('onboarding state not found for user', {email : user.email}));

    } else if (foundOnboardingState && foundOnboardingState.lastCompleted != 'markStoppingPoint') {
      pollMongoCallback (winston.makeError ('onboarding not complete for user. so not doing resume yet...', {email : user.email}));

    } else {

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
        'recoveryMode' : false,
        'recoveryModeStartPoint' : 'startAsync',
        'maxUid' : foundResumeTask.maxUid,
        'maxDate' : foundResumeTask.maxDate,
        'mailbox' : mailbox,
        'isPremium' : foundResumeTask.isPremium,
        'minProcessedDate' : user.minProcessedDate
      };

      // minDate only will exist if the user is not isPremium
      if (foundResumeTask.minDate) {
        argDict.minDate = foundResumeTask.minDate;
      } else if (!foundResumeTask.isPremium) {
        // not premium but also no minDate, so the resumeTask is malformed. Disable and send notification.
        sesUtils.sendInternalNotificationEmail (JSON.stringify (foundResumeTask), 'Malformed foundResumeTask', function (err) {
          if (err) {
            winston.doError ('sesUtils error sendInternalNotificationEmail', {err : err});
          }
        });

        pollMongoCallback (winston.makeError ('malformed foundResumeTask', {err : err}));
        return;
      }

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

        var opLen = operations.length;

        // this user has already been onboarded to completion, no reason to continue
        if (lastCompleted == operations[opLen-1].name) {
          pollMongoCallback ();
          return;
        }
        else {
          for (var i = 0; i < opLen; i++) {
            var operation = operations[i];
            if (operation.name == lastCompleted) {
              argDict.recoveryModeStartPoint = operations[i+1].name;
              argDict.recoveryMode = true;
              winston.doWarn('resume in recovery mode!', {recoveryMode : argDict.recoveryMode});
              winston.doWarn('new starting point', {start : operations[i+1].name});
              break;
            }

          }
        }
      }

      daemonUtils.getBandwithForUserDay (user._id, function (err, bandwith) {
        if (err) {
          pollMongoCallback (err);            
        } else {
          argDict.totalBandwith = bandwith;
          startWaterfall();            
        }
      });

      function startWaterfall() {
        async.waterfall (operations, function (err) {

          if (err) {
            pollMongoCallback (winston.makeError ('ResumeDownload: Could not finish updating', {err : err}));
          }
          else {
            winston.doInfo ('ResumeDownload: Finished resume job for user ', {userEmail :user.email});

            // close the mailbox
            imapConnect.closeMailbox (myConnection, function (err) {
              if (err) {
                winston.doError ('Could not close mailbox', {err : err});
              }
              else {
                imapConnect.logout (myConnection, function (err) {
                  if (err) {
                    winston.doError ('Could not logout', {err : err});
                  }
                });
              }
            });


            pollMongoCallback ();
          }

        });
      }

      // function needed to passthrough arguments
      function startAsync (callback) {
        callback (null, argDict);
      }

    }
  });


};
