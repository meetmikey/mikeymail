var Imap = require('imap'),
    constants = require ('../constants'),
    conf = require (constants.SERVER_COMMON + '/conf'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    imapConnect = require ('./imapConnect'),
    imapRetrieve = require ('./imapRetrieve'),
    mailUpdateDaemon = require ('./mailUpdateDaemon'),
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    conf = require (constants.SERVER_COMMON + '/conf'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    mongoPoll = require ('./mongoPoll'),
    crypto = require ('crypto'),
    xoauth2 = require("xoauth2");


var ActiveConnectionModel = mongoose.model ('ActiveConnection')

var openConnections = {};
var setTimestampIntervalIds = {};
var mailListenDaemon = this;

try {
  var myUniqueId = crypto.randomBytes(16).toString('hex');
  console.log ('myUniqueId is: %s', myUniqueId)
} catch (ex) {
  winston.doError ('Could not create random unique id for node process')
  process.exit (1)
}

exports.start = function () {
  winston.info ('starting mail listen daemon');
  
  sqsConnect.pollMailActiveConnectionQueue(function (message, pollQueueCallback) {

    console.log ('got poll queue message', message);
    var userInfo = JSON.parse (message);
    var userId = userInfo._id;

    var xoauthParams = {
      user: userInfo.email,
      clientId: conf.google.appId,
      clientSecret: conf.google.appSecret,
      refreshToken: userInfo.refreshToken      
    }

    xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);
    mailListenDaemon.connectAndListen (userInfo, xoauth2gen, pollQueueCallback);

  }, constants.MAX_UPDATE_JOBS);

  mongoPoll.start (myUniqueId, function (err, connections) {

    if (err) {
      winston.doError ('Could not poll active connections', {error : err});
      return;
    }

    var validConnections = {}

    connections.forEach (function (connection) {
      validConnections [connection._id] = 1;
    })

    for (var user in openConnections) {
      if (!(user in validConnections)) {
        imapConnect.logout (openConnections[user], function (err) {
          if (err) { winston.doError ('Could not log out user', {user : user, err:err}); }

          clearInterval (setTimestampIntervalIds [user]);
          delete setTimestampIntervalIds [user];
          delete openConnections [user];
        })
      }
    }

  })

}

exports.connectAndListen = function (userInfo, xoauth2gen, pollQueueCallback) {

  xoauth2gen.getToken(function(err, token) {
    if(err){
      winston.doError('Error: could not generate xoauth token', err)
      return
    }

    // connect to imap server
    var myConnection = imapConnect.createImapConnection (userInfo.email, token);

    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {

      if (err) {
        winston.doError ('Error: Could not open mailbox', err)
        return
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


      myConnection.on ("mail", function (num) {
        winston.info("new mail arrived for user: ", {num_messages : num, userId: userInfo._id});

        mailUpdateDaemon.updateMailbox (userInfo, myConnection, mailbox, keepMailboxOpen=true, function (err) {
          if (err) {
            winston.doError ('Error updating mailbox on listen daemon', {err :err, userId: userInfo._id});
            return;
          }

          winston.info ('Successfully updated  mailbox for user', {userId: userInfo._id});

        })

      })

      myConnection.on("deleted", function (msg) {
        winston.info ("something was deleted", msg);
      })

      myConnection.on("close", function (hadError) {
        winston.info ("the imap connection has closed with error state: ", hadError);
      })

      myConnection.on("end", function () {
        winston.info ("the imap connection has ended");
      })

      myConnection.on("alert", function (alertMsg) {
        winston.doError ('Alert message received from IMAP server: ', alertMsg);
      })

    })

  })
}


// at intervals update the active connection record in the db to indicate we are still
// here and actively listening for new mail messages.
exports.setListeningTimestampLoop = function (userId, callback) {
  
  var intervalId = setInterval (function () {
    winston.info ('update listening timestamp');
    ActiveConnectionModel.update ({_id : userId, nodeId : myUniqueId}, 
      {$set : {'nodeId' : myUniqueId, 'mailListenTS' : Date.now()}}, 
      function (err, num) {
        if (err) {
          winston.doError ('Error: could not set myUniqueId: ', {error : err});
          callback (err);
        }
        else if (num == 0) {
          winston.doWarn ('Zero records affected error setListeningTimestampLoop', {myUniqueId : myUniqueId, userId : userId});
          callback (null, intervalId);
        }
        else {
          callback (null, intervalId);
        }
      })  
  }, constants.LISTENING_TIMESTAMP_INTERVAL);

}


exports.setActiveConnectionAndCallback = function (userInfo, pollQueueCallback){

  ActiveConnectionModel.update ({_id : userInfo._id}, 
    {$set : {'nodeId' : myUniqueId, 'mailListenTS' : Date.now()}}, 
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

        mailListenDaemon.setListeningTimestampLoop (userInfo._id, 
          function (err, intervalId) {
            if (err) { 
              // already logged below 
            }
            else {
              setTimestampIntervalIds [userInfo._id] = intervalId;
            }
          });
      }
    })

}