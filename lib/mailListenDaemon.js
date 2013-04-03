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


var ActiveConnectionModel = mongoose.model ('ActiveConnection');
var UserOnboardingStateModel = mongoose.model ('UserOnboardingState');

var openConnections = {};
var myTimestampLoops = {};
var mailListenDaemon = this;

var myUniqueId = constants.MY_NODE_ID;

exports.start = function () {
  winston.doInfo ('starting mail listen daemon');
  
  // poll for new active connection jobs to process on the queue
  sqsConnect.pollMailActiveConnectionQueue(function (message, pollQueueCallback) {

    console.log ('got poll queue message', message);
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
          mailListenDaemon.attemptToSetActiveConnection(userInfo, function (err) {
            if (err) {
              // warn... active connection already claimed
              if (err.warn) {
                pollQueueCallback ();
              }
              else {
                pollQueueCallback (err);
              }
            }
            else {
              pollQueueCallback ();
              var xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);
              mailListenDaemon.connectAndListen (userInfo, xoauth2gen); 
            }
          });
        }
      });

    });

  }, constants.MAX_UPDATE_JOBS);


  // poll to check for dropped active connections
  mongoPoll.startPollingConnections (myUniqueId, function (err, connections) {

    if (err) {
      winston.handleError (err);
      return;
    }

    console.log ('CURRENT OPEN CONNECTIONS', Object.keys(openConnections));

    var validConnections = {};

    connections.forEach (function (connection) {
      validConnections [String (connection._id)] = 1;
    });

    for (var key in openConnections) {
      console.log ('the open connections', openConnections[key]);
    }

    console.log ('CURRENT VALID CONNECTIONS', validConnections);

    for (var user in openConnections) {
      if (!(user in validConnections)) {
        winston.doInfo ("Logging out user because they aren't active anymore", {user : user});
        imapConnect.logout (openConnections[user], function (err) {
          if (err && err.message == 'Not connected') { 
            winston.doWarn ('Could not logout user', {user : user, message:err.message, stack : err.stack});
          }
          else if (err) {
            winston.doError('Could not logout user', {user : user, message:err.message, stack : err.stack});
          }
          else {
            winston.doInfo ("User has been logged out", {user : user});
          }

          mailListenDaemon.clearConnection (user);
        });
      }
    }
  });


  setInterval (function () {
    winston.info ('setInterval firing to do a random imap command...');
    for (var user in openConnections) {
      imapRetrieve.fetchBoxesToStayAlive (openConnections[user], user);
    }
  }, constants.POLL_IMAP_HACK_TIME);


}

exports.connectAndListen = function (userInfo, xoauth2gen) {

  winston.doInfo ('connectAndListen for user', {user : userInfo});

  if (userInfo._id in openConnections) {
    winston.doWarn ('connection already opened for user', {userId : userInfo._id, userEmail : userInfo.email});
    return;
  }


  xoauth2gen.getToken(function(err, token) {
    if(err){
      winston.doError('Error: could not generate xoauth token', {err : err, userEmail : userInfo.email, userId : userInfo._id});
      mailListenDaemon.clearConnection (userInfo._id);
      return;
    }

    // connect to imap server
    var myConnection = imapConnect.createImapConnection (userInfo.email, token);

    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {

      if (err) {
        winston.handleError (err);
        mailListenDaemon.clearConnection (userInfo._id);
        return;
      }

      winston.doInfo ('mailListenDaemon: connection opened for user', {userEmail : userInfo.email});
      // set the connection as open and claim the db active connection object
      mailListenDaemon.setOpenConnection (userInfo._id, myConnection);

      // update mailbox right away on new connection
      mailListenDaemon.runUpdateMailbox (userInfo, myConnection, mailbox, 0, true, true);

      // update mailbox on new mail events
      myConnection.on ("mail", function (numMsgs) {
        winston.info("new mail arrived for user: ", {num_messages : numMsgs, userId: userInfo._id, userEmail : userInfo.email});
        mailListenDaemon.runUpdateMailbox (userInfo, myConnection, mailbox, numMsgs, false, true);
      });

      myConnection.on("deleted", function (seqno) {
        winston.doInfo ("msg deleted with sequence number", {seqno : seqno});
      });

      myConnection.on("close", function (hadError) {
        if (hadError) {
          winston.doError ("the imap connection has closed with error state: ", {error : hadError});
        }
        else {
          winston.doWarn ("imap connection closed for user", {userId :userInfo._id, userEmail : userInfo.email});
        }
      });

      myConnection.on ("msgupdate", function (msg) {
        winston.info ('A MESSAGES FLAGS HAVE CHANGED', {msg : msg});
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


exports.clearConnection = function (userId) {
  mailListenDaemon.deleteOpenConnection (userId);
  mongoPoll.clearTimeIntervalLoop (userId, myTimestampLoops, 'listen');
}


exports.setOpenConnection = function (userId, connection) {
  openConnections [String (userId)] = connection;
}

exports.deleteOpenConnection = function (userId, connection) {
  delete openConnections[String (userId)];
}

exports.attemptToSetActiveConnection = function (userInfo, callback){
  winston.info ('mailListenDaemon: attemptToSetActiveConnectionAndCallback');

  ActiveConnectionModel.update ({_id : userInfo._id, nodeId : {$exists : false}},
    {$set : {'nodeId' : myUniqueId, 'mikeyMailTS' : Date.now()}}, 
    function (err, num) {
      if (err) {
        winston.doMongoError (err);
        callback (err);
      }
      else if (num == 0) {
        winston.doWarn ('Zero records affected error ', {myUniqueId : myUniqueId, userId : userInfo._id});
        callback ({'warn' : 'no records affected'});
      }
      else {
        winston.doInfo ('Deleting message from queue', {userId : String(userInfo._id)});
        callback ();

        mongoPoll.setWorkingTimestampLoop (ActiveConnectionModel, 
          constants.LISTENING_TIMESTAMP_UPDATE_INTERVAL,
          userInfo._id, 
          function (err, intervalId) {
            if (err) { 
              winston.handleError (err);
            }
            else {
              mongoPoll.setTimestampInterval (userInfo._id, intervalId, myTimestampLoops);
            }
          });
      }
    })

}