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
var imapListen = this;

try {
  var myUniqueId = crypto.randomBytes(32).toString('hex');
  console.log ('myUniqueId is: %s', myUniqueId)
} catch (ex) {
  winston.doError ('Could not create random unique id for node process')
  process.exit (1)
}

exports.start = function () {
  
  //TODO: poll the correct queue
  sqsConnect.pollMailUpdateQueue(function (message, pollQueueCallback) {

    console.log ('got poll queue message', message)
    var userInfo = JSON.parse (message)
    var userId = userInfo._id

    var xoauthParams = {
      user: userInfo.email,
      clientId: conf.google.appId,
      clientSecret: conf.google.appSecret,
      refreshToken: userInfo.refreshToken      
    }

    console.log (userInfo.expiresAt)

    if (userInfo.accessToken
        && (userInfo.expiresAt && userInfo.expiresAt < Date.now() - constants.ACCESS_TOKEN_UPDATE_TIME_BUFFER)) {
      xoauthParams.accessToken = userInfo.accessToken
    }

    xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);

    imapListen.connectAndListen (userInfo, xoauth2gen, pollQueueCallback)

  }, constants.MAX_UPDATE_JOBS)

  mongoPoll.start (myUniqueId, function (err, connections) {

    if (err) {
      winston.doError ('Could not poll active connections', {error : err})
      return;
    }

    console.log ('connections active', connections)

    var validConnections = {}

    connections.forEach (function (connection) {
      validConnections [connection.userId] = 1
    })

    for (var user in openConnections) {
      if (!(user in validConnections)) {
        imapConnect.logout (openConnections[user], function (err) {
          if (err) { winston.doError ('Could not log out user', {user : user, err:err}) }

          delete openConnections [user]
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
    var myConnection = imapConnect.createImapConnection (userInfo.email, token)



    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {

      if (err) {
        winston.doError ('Error: Could not open mailbox', err)
        return
      }

      winston.info ('Connection opened for user: ' + userInfo.email)
      winston.info ('Mailbox opened', mailbox)

      ActiveConnectionModel.update ({userId : userInfo._id}, {$set : {'nodeId' : myUniqueId}}, function (err, num) {
        if (err) {
          winston.doError ('Error: could not set myUniqueId: ', {error : err})
        }
        else if (num == 0) {
          winston.doWarn ('Zero records affected error ', {myUniqueId : myUniqueId, userId : userInfo._id})
        }
      })

      //TODO: where should i do this
      pollQueueCallback();

      // add to dictionary of currently open connections
      if (userInfo._id in openConnections) {
        winston.warn ('Open connection already opened for user ' + userInfo._id)
      }
      else {
        openConnections[userInfo._id] = myConnection
      }


      myConnection.on ("mail", function (num) {
        winston.info("new mail arrived for user: ", {num_messages : num, userId: userInfo._id})

        mailUpdateDaemon.updateMailbox (userInfo, myConnection, mailbox, function (err) {
          if (err) {
            winston.doError ('Error updating mailbox on listen daemon', {err :err, userId: userInfo._id})
            return
          }

          winston.info ('Successfully updated  mailbox for user', {userId: userInfo._id})

        })

      })

      myConnection.on("deleted", function (msg) {
        winston.info ("something was deleted", msg)
      })

      myConnection.on("close", function (hadError) {
        winston.info ("the imap connection has closed with error state: ", hadError)
      })

      myConnection.on("end", function () {
        winston.info ("the imap connection has ended")
      })

      myConnection.on("alert", function (alertMsg) {
        winston.doError ('Alert message received from IMAP server: ', alertMsg)
      })

    })

  })
}

