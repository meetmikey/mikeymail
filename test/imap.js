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

var userInfo = {"shortId":"9s","googleID":"105193733433707716669","accessHash":"93b98366e37c8824891a82cda2ad632a46ceffe5f8c29dd04a509d8483c631631483f132da276f602382676e68911d5ceb7f45e300683216c303c892e5b2132e","displayName":"Tomáš Růžička","firstName":"Tomáš","lastName":"Růžička","email":"zusex4@gmail.com","gender":"male","locale":"en","picture":"https://lh5.googleusercontent.com/-r3kq5MYQCm8/AAAAAAAAAAI/AAAAAAAAHhQ/4ndf_kBySY8/photo.jpg","expiresAt":"2013-07-03T20:54:04.569Z","symHash":"bf93f8feed65b32a613c6bad46554d2360a0d73261ed84718a19b49951a27b2ddb33c0fa2df246b11925fd73ee77bcb888146070182505e2de913070eb26d6de","symSalt":"b69950f6aae0cc40","asymHash":"$2a$08$y85VvYZJ6dCdi0qlPlyft.h6uqi92Mel5iYfEtnY4HYwclPFEbXBa","asymSalt":"$2a$08$y85VvYZJ6dCdi0qlPlyft.","_id":"51d4815ce992bcdf6100504e","__v":0,"isPremium":false,"daysLimit":90,"minMRProcessedDate":"2013-07-03T19:54:04.631Z","minProcessedDate":"2013-07-03T19:54:04.631Z","timestamp":"2013-07-03T19:54:04.630Z","invalidToken":false,"gmailScrapeRequested":true,"accessToken":"ya29.AHES6ZQHRpCvHjVqWKwnJM_2OsMoZv7O-AA0SGf_-cks-9g","refreshToken":"1/s9yEFSvdW4_oCUMcVqMvIZndpR3a7pstgKM5eYDNVUg","directReferralLink":"http://gmailw.in/9s/d","facebookReferralLink":"http://gmailw.in/9s/f","twitterReferralLink":"http://gmailw.in/9s/t","id":"51d4815ce992bcdf6100504e"}


appInitUtils.initApp( 'resumeDownload', initActions, null, function() {

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
  })

});

