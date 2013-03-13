var constants = require ('../constants'),
    conf = require (constants.SERVER_COMMON + '/conf'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    imapConnect = require ('./imapConnect'),
    mailUpdateDaemon = require ('./mailUpdateDaemon'),
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    conf = require (constants.SERVER_COMMON + '/conf'),
    daemonUtils = require ('./daemonUtils'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
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
      else {
        winston.info ('user onboarding not completed so not running update', 
          {stateId : foundState._id, userId : userInfo._id, email : userInfo.email});
        pollQueueCallback();
      }
    });


  }, constants.MAX_UPDATE_JOBS);

  mongoPoll.startPollingConnections (myUniqueId, function (err, connections) {

    if (err) {
      winston.doError ('Could not poll active connections', {error : err});
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
        winston.info ('user open connections', openConnections[user]);
        imapConnect.logout (openConnections[user], function (err) {
          if (err) { winston.doError ('Could not logout user', {user : user, err:err}); }

          if (!setTimestampIntervalIds [user]) {
            winston.doWarn ('No setTimestampIntervalIds for key', {userId : user});
          }

          clearInterval (setTimestampIntervalIds [user]);
          delete setTimestampIntervalIds [user];
          delete openConnections [user];
          console.log ('user logged out', openConnections);
        })
      }
    }

  })

}

exports.connectAndListen = function (userInfo, xoauth2gen, pollQueueCallback) {

  winston.doInfo ('connectAndListen for user', {user : userInfo});

  xoauth2gen.getToken(function(err, token) {
    if(err){
      winston.doError('Error: could not generate xoauth token', err);
      return;
    }

    // connect to imap server
    var myConnection = imapConnect.createImapConnection (userInfo.email, token);

    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {

      if (err) {
        winston.doError ('Error: Could not open mailbox', {err : err, userInfo : userInfo});
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

      var numNew = 0;

      // update mailbox right away on new connection
      mailUpdateDaemon.updateMailbox (userInfo, myConnection, mailbox, numNew, keepMailboxOpen=true, function (err) {
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


      myConnection.on ("mail", function (numMsgs) {
        winston.info("new mail arrived for user: ", {num_messages : numMsgs, userId: userInfo._id});

        mailUpdateDaemon.updateMailbox (userInfo, myConnection, mailbox, numMsgs, keepMailboxOpen=true, function (err) {
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
      });

      myConnection.on("deleted", function (seqno) {
        winston.info ("msg deleted with sequence number", seqno);
      });

      myConnection.on("close", function (hadError) {
        winston.info ("the imap connection has closed with error state: ", hadError);
      });

      myConnection.on("end", function () {
        winston.info ("the imap connection has ended");
      });

      myConnection.on("alert", function (alertMsg) {
        winston.doError ('Alert message received from IMAP server: ', alertMsg);
      });
    })

  })
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
              setTimestampIntervalIds [userInfo._id] = intervalId;
            }
          });
      }
    })

}