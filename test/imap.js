var serverCommon = process.env.SERVER_COMMON;
var appInitUtils = require(serverCommon + '/lib/appInitUtils')
    , imapConnect = require ('../lib/imapConnect')
    , daemonUtils = require ('../lib/daemonUtils')
    , winston = require (serverCommon + '/lib/winstonWrapper').winston
    , util = require ('util')
    , xoauth2 = require("xoauth2")
    , UserModel = require (serverCommon + '/schema/user').UserModel
    , imapRetrieve = require ('../lib/imapRetrieve');

var initActions = [
  appInitUtils.CONNECT_MONGO
];

appInitUtils.initApp( 'resumeDownload', initActions, null, function() {


  UserModel.findById ("51c34ae5bf81d63633000009", function (err, userInfo) {

    console.log (userInfo.accessToken)

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
          winston.doError ('Error: Could not open mailbox', {error : err, userEmail : userInfo.email, errorType: winston.getErrorType (err)});
          return;
        }

        myConnection.on("close", function (hadError) {
          if (hadError) {
            winston.doError ("the imap connection has closed with error state: ", {error : hadError});
          }
          else {
            winston.doWarn ("imap connection closed for user", {userId :userInfo._id, userEmail : userInfo.email});
          }
        })

        winston.doInfo ('Mailbox opened for user' + {email: userInfo.email, mailbox: mailbox})

        setTimeout (function () {

          imapConnect.closeMailbox (myConnection, function (err) {
            winston.doInfo('mailbox closed');
            if (err) {
              winston.doInfo('error closing mailbox', {err: err});
            }
          })
        }, 10000);
          // fetch some messages
          /*
          imapRetrieve.getMessagesByUid (myConnection, userInfo._id, [{uid : '174539'}], false, function (err, bandwidth) {
            if (err) {
              winston.doError (err);
            }
            else {
              winston.doInfo ('all messages callback with bandwidth used', {bandwidth: bandwidth});
            }
          });
          imapRetrieve.getHeaders (myConnection, userInfo._id, '12345', '174539', '*', null, function (err, bandwidth) {
            if (err) {
              winston.doError (err);
            }
            else {
              winston.doInfo ('all messages callback with bandwidth used', {bandwidth: bandwidth});
            }
          });
          */

      });

    });
  })

});

