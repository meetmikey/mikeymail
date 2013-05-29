var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants'),
    conf = require (serverCommon + '/conf'),
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose,
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    sqsConnect = require(serverCommon + '/lib/sqsConnect'),
    imapConnect = require ('./imapConnect'),
    mailUpdateDaemon = require ('./mailUpdateDaemon'),
    sqsConnect = require(serverCommon + '/lib/sqsConnect'),
    conf = require (serverCommon + '/conf'),
    daemonUtils = require ('./daemonUtils'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    mongoPoll = require ('./mongoPoll'),
    imapRetrieve = require ('./imapRetrieve'),
    xoauth2 = require("xoauth2");


var UserOnboardingStateModel = mongoose.model ('UserOnboardingState');

var mailListenDaemon = this;

var myUniqueId = constants.MY_NODE_ID;

exports.start = function () {
  winston.doInfo ('starting mail listen daemon');
  
  // poll for new active connection jobs to process on the queue
  sqsConnect.pollMailActiveConnectionQueue(function (message, pollQueueCallback) {

    var userMsg = JSON.parse (message);

    daemonUtils.getUserInfoFromDB (userMsg._id, function (err, userInfo) {

      if (err) {
        pollQueueCallback (err);
        return;
      }

      var xoauthParams = daemonUtils.getXOauthParams (userInfo);

      // ensure user has been onboarded before opening a new IMAP connection
      UserOnboardingStateModel.findOne ({userId : userInfo._id, lastCompleted : 'markStoppingPoint'}, 
        function (err, foundState) {
        if (err) {
          winston.doError ('Mongo error looking up user onboarding state', {error : err});
          pollQueueCallback();
        }
        else if (!foundState) {
          winston.doInfo ('user onboarding not completed so not running update', 
            {userId : userInfo._id, email : userInfo.email});
          pollQueueCallback();
        }
        else {
          pollQueueCallback ();
          var xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);
          mailListenDaemon.connectAndUpdate (userInfo, xoauth2gen);
        }
      });

    });

  }, constants.MAX_UPDATE_JOBS);

}

exports.connectAndUpdate = function (userInfo, xoauth2gen) {

  winston.doInfo ('connectAndListen for user', {user : userInfo});

  xoauth2gen.getToken(function(err, token) {
    if(err){
      winston.doWarn('Warning: mailListenDaemon: could not generate xoauth token', {err : err, userEmail : userInfo.email, userId : userInfo._id});

      // invalid grant = token must be invalid      
      if (err == 'invalid_grant') {
        daemonUtils.updateUserTokenValidity (userInfo._id, function (err) {
          if (err) {
            winston.handleError (err);
          }
        });
      }

      return;
    }

    // connect to imap server
    var myConnection = imapConnect.createImapConnection (userInfo.email, token);

    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {

      if (err) {
        winston.handleError (err);
        return;
      }

      winston.doInfo ('mailListenDaemon: connection opened for user', {userEmail : userInfo.email});

      // update mailbox right away on new connection
      mailListenDaemon.runUpdateMailbox (userInfo, myConnection, mailbox, 0, true, false);

      myConnection.on("close", function (hadError) {
        if (hadError) {
          winston.doWarn ("the imap connection has closed with error state: ", {error : hadError, userEmail : userInfo.email});
        }
        else {
          winston.doInfo ("imap connection closed for user", {userId :userInfo._id, userEmail : userInfo.email});
        }
      });

    });

  });
}

exports.runUpdateMailbox = function (userInfo, myConnection, mailbox, numMsgs, isInitialConnectUpdate, keepMailboxOpen) {
  mailUpdateDaemon.updateMailbox (userInfo, myConnection, mailbox, numMsgs, isInitialConnectUpdate, keepMailboxOpen, function (err) {
    if (err && !err.warning) {
      winston.doError ('Error updating mailbox on listen daemon', {err :err, userId: userInfo._id});
    }
    else if (err && err.warning) {
      winston.doWarn ('Not updating mailbox in listen daemon', {err :err, userId: userInfo._id});
    }
    else {
      winston.doInfo ('Successfully updated  mailbox for user', {userId: userInfo._id, userEmail : userInfo.email});
    }
  });
}
