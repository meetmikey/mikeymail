var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants'),
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose,
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    sqsConnect = require(serverCommon + '/lib/sqsConnect'),
    imapConnect = require ('./imapConnect'),
    mailUpdateHelper = require ('./mailUpdateHelper'),
    daemonUtils = require ('./daemonUtils'),
    mikeymailConstants = require ('../constants'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    xoauth2 = require("xoauth2");


var UserOnboardingStateModel = mongoose.model ('UserOnboardingState');

var mailListenDaemon = this;

exports.start = function () {
  winston.doInfo ('starting mail listen daemon');
  
  // poll for new active connection jobs to process on the queue
  sqsConnect.pollMailActiveConnectionQueue(function (message, pollQueueCallback) {

    var userMsg = JSON.parse (message);

    daemonUtils.getUserInfoFromDB (userMsg._id, function (err, user) {

      if (err) {
        pollQueueCallback (err);
        return;
      }

      var xoauthParams = daemonUtils.getXOauthParams (user);

      // ensure user has been onboarded before opening a new IMAP connection
      UserOnboardingStateModel.findOne ({userId : user._id, lastCompleted : 'markStoppingPoint'}, 
        function (err, foundState) {
        if (err) {
          winston.doError ('Mongo error looking up user onboarding state', {error : err});
          pollQueueCallback();
        }
        else if (!foundState) {
          winston.doInfo ('user onboarding not completed so not running update', 
            {userId : user._id, email : user.email});
          pollQueueCallback();
        }
        else {
          pollQueueCallback ();
          var xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);
          mailListenDaemon.connectAndUpdate (user, xoauth2gen);
        }
      });

    });

  }, constants.MAX_UPDATE_JOBS);

}

exports.connectAndUpdate = function (user, xoauth2gen) {

  winston.doInfo ('connectAndListen for user', {userEmail : user.email});

  xoauth2gen.getToken(function(err, token) {
    if(err){
      winston.doWarn('Warning: mailListenDaemon: could not generate xoauth token', {err : err, userEmail : user.email, userId : user._id});

      // invalid grant = token must be invalid      
      if (err == 'invalid_grant') {
        daemonUtils.updateUserTokenValidity (user._id, function (err) {
          if (err) {
            winston.handleError (err);
          }
        });
      }

      return;
    }

    // connect to imap server
    var myConnection = imapConnect.createImapConnection (user.email, token);

    // open mailbox
    imapConnect.openMailbox (myConnection, user.email, function (err, mailbox) {
      if (err) {
        var errorType = winston.getErrorType (err);
        if (errorType === mikeymailConstants.ERROR_TYPE_ALL_MAIL_DOESNT_EXIST ||
            errorType === mikeymailConstants.ERROR_TYPE_NO_BOX_TO_OPEN) {

          winston.doWarn ('connectAndListen error for user', {user : user.email, errorType : errorType});

          if (!user.allMailError) {
            daemonUtils.setUserAllMailError (false, user, errorType, function (err) {
              if (err) { winston.handleError (err); }
            });
          }
        } else if (errorType === 'timeout') {
          winston.doWarn ('mailListenDaemon: imap connect warning - timeout', {userEmail : user.email});
        } else {
          winston.handleError (err);
        }

        return;
      }

      if (user.allMailError) { daemonUtils.unSetUserAllMailError (user); }

      winston.doInfo ('mailListenDaemon: connection opened for user', {userEmail : user.email});

      // update mailbox right away on new connection
      mailListenDaemon.runUpdateMailbox (user, myConnection, mailbox, 0);

      myConnection.on("close", function (hadError) {
        if (hadError) {
          winston.doWarn ("the imap connection has closed with error state: ", {error : hadError, userEmail : user.email});
        }
        else {
          winston.doInfo ("imap connection closed for user", {userId :user._id, userEmail : user.email});
        }
      });

    });

  });
}

exports.runUpdateMailbox = function (user, myConnection, mailbox, numMsgs) {
  mailUpdateHelper.updateMailbox (user, myConnection, mailbox, numMsgs, function (err) {
    if (err && !err.warning) {
      winston.doError ('Error updating mailbox on listen daemon', {err :err, userId: user._id});
    }
    else if (err && err.warning) {
      winston.doWarn ('Not updating mailbox in listen daemon', {err :err, userId: user._id});
    }
    else {
      winston.doInfo ('Successfully updated  mailbox for user', {userId: user._id, userEmail : user.email});
    }
  });
}
