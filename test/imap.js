var serverCommon = process.env.SERVER_COMMON;
var appInitUtils = require(serverCommon + '/lib/appInitUtils')
    , imapConnect = require ('../lib/imapConnect')
    , daemonUtils = require ('../lib/daemonUtils')
    , winston = require (serverCommon + '/lib/winstonWrapper').winston
    , xoauth2 = require("xoauth2")
    , imapRetrieve = require ('../lib/imapRetrieve');

var initActions = [
  appInitUtils.CONNECT_MONGO
];

appInitUtils.initApp( 'resumeDownload', initActions, null, function() {

  var userInfo = {
    "__v" : 0,
    "_id" : "514265596a9290970a000007",
    "accessToken" : "ya29.AHES6ZTBuFtcMLEQcC6IvSP768EvPDcRFnvMhBZnde8YkBM",
    "displayName" : "Sagar Mehta",
    "email" : "sagar@mikeyteam.com",
    "expiresAt" : "2013-03-18T08:02:06.712Z",
    "firstName" : "Sagar",
    "gmailScrapeRequested" : true,
    "googleID" : "115882407960585095714",
    "hostedDomain" : "mikeyteam.com",
    "lastName" : "Mehta",
    "locale" : "en",
    "refreshToken" : "1/Pz7L9qUASDlLlZQecvLsAspqVBu76iczVH1pZyVLLgY",
    "timestamp" : "2013-03-15T00:03:37.728Z"
  }

  /*
  var userInfo = {
    "__v" : 0,
    "_id" : "51434e7083da667b0d000005",
    "accessToken" : "ya29.AHES6ZQyo8U72Spg8fax09HcZQjBRhnhD6ikWgV7xzrXT5s",
    "displayName" : "Mudit Garg",
    "email" : "muditgarg@gmail.com",
    "expiresAt" : "2013-03-19T09:37:45.729Z",
    "firstName" : "Mudit",
    "gender" : "male",
    "gmailScrapeRequested" : true,
    "googleID" : "111291087832139466141",
    "lastName" : "Garg",
    "locale" : "en",
    "refreshToken" : "1/bzQjJkZh1q0QOIsEMYPbNLf7PJrGaH7FWCaztIwRA3w",
    "timestamp" : "2013-03-15T16:38:08.468Z"
  }
  */

  var xoauthParams = daemonUtils.getXOauthParams (userInfo);
  var xoauth2gen = xoauth2.createXOAuth2Generator(xoauthParams);

  // open a mailbox
  xoauth2gen.getToken(function(err, token) {
    if(err){
      winston.doError('Error: could not generate xoauth token', {error : err, userEmail : userInfo.email});
      return;
    }
   
    // connect to imap server
    var myConnection = imapConnect.createImapConnection (userInfo.email, token)
    
    // open mailbox
    imapConnect.openMailbox (myConnection, function (err, mailbox) {

      if (err) {
        winston.doError ('Error: Could not open mailbox', {error : err, userEmail : userInfo.email});
        return;
      }

      winston.info ('Connection opened for user: ' + userInfo.email)
      winston.info ('Mailbox opened', mailbox)

      console.log (myConnection);

      // update mailbox on new mail events
      myConnection.on ("mail", function (numMsgs) {
        winston.info("new mail arrived for user: ", {num_messages : numMsgs, userId: userInfo._id, userEmail : userInfo.email});
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


        // fetch some messages
        /*
        imapRetrieve.getMessagesByUid (myConnection, userInfo._id, [{uid : '174539'}], false, function (err, bandwith) {
          if (err) {
            winston.doError (err);
          }
          else {
            winston.info ('all messages callback with bandwith used', bandwith);
          }
        });
        imapRetrieve.getHeaders (myConnection, userInfo._id, '12345', '174539', '*', null, function (err, bandwith) {
          if (err) {
            winston.doError (err);
          }
          else {
            winston.info ('all messages callback with bandwith used', bandwith);
          }
        });
        */

    });

  });


});

