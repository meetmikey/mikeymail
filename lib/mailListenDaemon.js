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
    xoauth2 = require("xoauth2");


var ActiveConnectionModel = mongoose.model ('ActiveConnection')
var UserOnboardingStateModel = mongoose.model ('UserOnboardingState')

var openConnections = {};
var setTimestampIntervalIds = {};
var mailListenDaemon = this;

var myUniqueId = constants.MY_NODE_ID;

exports.start = function () {
  winston.info ('starting mail listen daemon');
  
  sqsConnect.pollMailActiveConnectionQueue(function (message, pollQueueCallback) {

    console.log ('got poll queue message', message);
    var userInfo = JSON.parse (message);
    var xoauthParams = daemonUtils.getXOauthParams (userInfo);

    // ensure user has been onboarded otherwise let the message sit on the queue
    UserOnboardingStateModel.findOne ({userId : userInfo._id}, function (err, foundState) {
      if (err) {
        winston.doError ('Mongo error looking up user onboarding state', {error : err});
        pollQueueCallback();
      }
      else if (foundState && foundState.lastCompleted === 'markStoppingPoint') {

        if (userInfo._id in openConnections) {
          winston.info ('Connection already open for user in current node');
          pollQueueCallback();
        }
        else {
          var xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);
          mailListenDaemon.connectAndListen (userInfo, xoauth2gen, pollQueueCallback);
        }

      }
      else if (foundState) {
        winston.doInfo ('user onboarding not completed so not running update', 
          {stateId : foundState._id, userId : userInfo._id, email : userInfo.email});
        pollQueueCallback();
      }
      else {
        winston.doError ('onboarding state not found for user', {userId : userInfo._id});
        pollQueueCallback();
      }
    });


  }, constants.MAX_UPDATE_JOBS);

  mongoPoll.startPollingConnections (myUniqueId, function (err, connections) {

    if (err) {
      winston.handleError (err);
      return;
    }

    console.log ('CURRENT OPEN CONNECTIONS', Object.keys(openConnections));

    var validConnections = {};

    connections.forEach (function (connection) {
      validConnections [connection._id] = 1;
    })

    console.log ('VALID CONNECTIONS', validConnections)

    for (var user in openConnections) {
      console.log ("user", user);
      console.log ("isValid", user in validConnections);
      if (!(user in validConnections)) {
        winston.doInfo ("Logging out user because they aren't active anymore");
        imapConnect.logout (openConnections[user], function (err) {

          if (err && err.message == 'Not connected') { 
            winston.doWarn ('Could not logout user', {user : user, message:err.message, stack : err.stack});
          }
          else if (err) {
            winston.doError('Could not logout user', {user : user, message:err.message, stack : err.stack});
          }
          else {
            winston.doInfo ("User has been logged out");
          }

          mailListenDaemon.clearTimeIntervalLoop (user);

        });
      }
    }
  });

}

exports.clearTimeIntervalLoop = function (userId) {
  winston.doInfo ('clearTimeIntervalLoop for user', {userId : userId});

  delete openConnections [userId];
  
  if (!setTimestampIntervalIds [String(userId)]) {
    var keys = Object.keys(setTimestampIntervalIds)
    winston.doError ('No setTimestampIntervalIds for key', {userId : userId, setTimestampIntervalKeys : keys});
  }
  else {
    clearInterval (setTimestampIntervalIds [String(userId)]);
    delete setTimestampIntervalIds [String(userId)];    
  }

}


exports.connectAndListen = function (userInfo, xoauth2gen, pollQueueCallback) {

  winston.doInfo ('connectAndListen for user', {user : userInfo});

  xoauth2gen.getToken(function(err, token) {
    if(err){
      winston.doError('Error: could not generate xoauth token', err);
      mailListenDaemon.clearTimeIntervalLoop (userInfo._id);
      return;
    }

    // connect to imap server
    var myConnection = imapConnect.createImapConnection (userInfo.email, token);

    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {

      if (err) {
        winston.doError ('Error: Could not open mailbox', {err : err, userInfo : userInfo});
        mailListenDaemon.clearTimeIntervalLoop (userInfo._id);
        return;
      }

      winston.info ('Connection opened for user: ' + userInfo.email);
      winston.info ('Mailbox opened', mailbox);
      mailListenDaemon.setActiveConnectionAndCallback (userInfo, pollQueueCallback);

      // add to dictionary of currently open connections
      if (userInfo._id in openConnections) {
        winston.warn ('Open connection already opened for user ' + userInfo._id);
      }
      else {
        openConnections[userInfo._id] = myConnection;
      }


      // update mailbox right away on new connection
      // function (userInfo, myConnection, mailbox, numMsgs, isInitialConnectUpdate, keepMailboxOpen)
      mailListenDaemon.runUpdateMailbox (userInfo, myConnection, mailbox, 0, true, true);

      // update mailbox on new mail events
      myConnection.on ("mail", function (numMsgs) {
        winston.info("new mail arrived for user: ", {num_messages : numMsgs, userId: userInfo._id});
        // function (userInfo, myConnection, mailbox, numMsgs, isInitialConnectUpdate, keepMailboxOpen)
        mailListenDaemon.runUpdateMailbox (userInfo, myConnection, mailbox, numMsgs, false, true);
      });

      myConnection.on("deleted", function (seqno) {
        winston.doInfo ("msg deleted with sequence number", {seqno : seqno});
      });

      myConnection.on("close", function (hadError) {
        if (hadError) {
          winston.doInfo ("the imap connection has closed with error state: ", {error : hadError});
        }
      });

      myConnection.on("end", function () {
        winston.info ("the imap connection has ended");
      });

      myConnection.on("alert", function (alertMsg) {
        winston.doError ('Alert message received from IMAP server: ', alertMsg);
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


exports.setActiveConnectionAndCallback = function (userInfo, pollQueueCallback){

  ActiveConnectionModel.update ({_id : userInfo._id}, 
    {$set : {'nodeId' : myUniqueId, 'mikeyMailTS' : Date.now()}}, 
    function (err, num) {
      if (err) {
        winston.doError ('Error: could not set myUniqueId: ', {error : err});
      }
      else if (num == 0) {
        winston.doWarn ('Zero records affected error ', {myUniqueId : myUniqueId, userId : userInfo._id});
      }
      else {
        pollQueueCallback();
        winston.doInfo ('Deleting message from queue', {userId : String(userInfo._id)});

        mongoPoll.setWorkingTimestampLoop (ActiveConnectionModel, 
          constants.LISTENING_TIMESTAMP_UPDATE_INTERVAL,
          userInfo._id, 
          function (err, intervalId) {
            if (err) { 
              winston.handleError (err);
            }
            else {
              setTimestampIntervalIds [String(userInfo._id)] = intervalId;
            }
          });
      }
    })

}