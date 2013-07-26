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


var userInfo = { 
  shortId: '3',
  googleID: '115882407960585095714',
  accessHash: '5e48a473d7ece234354547da9df6a254d540b2f4e201a9fd1ca9e7ffafc8d472c68516486e961e7708a573ab27b4ddf8ff62698c43e1cba219aefda8a2cff3bc',
  displayName: 'Sagar Mehta',
  firstName: 'Sagar',
  lastName: 'Mehta',
  email: 'sagar@mikeyteam.com',
  locale: 'en',
  hostedDomain: 'mikeyteam.com',
  symHash: 'aac4ac6bdccc441847168409dbae383fcdf526d7231c723ae9c66748292fb5440a5fea1567a724c84a1f6065c017421eb8c71ab83b3847380d4113038ce97759',
  symSalt: 'e5cedc3404f2e514',
  asymHash: '$2a$08$bB3HOAsOt7nz9r1Fo41j7eCZrq7DybObFjTfsMRm2.O6zTRAkrwia',
  asymSalt: '$2a$08$bB3HOAsOt7nz9r1Fo41j7e',
  _id: '51f1cb1eb34fd7255400000a',
  __v: 0,
  allMailOnboardAttempts: 0,
  isPremium: false,
  daysLimit: 110,
  invalidToken: false,
  gmailScrapeRequested: true,
  accessToken: 'ya29.AHES6ZSnyZSU8rwMWf5Suxd8n68j1EU6hgrFdE6_UQv8mMuUqoHx_w',
  refreshToken: '1/L0iwlnvZ0Mq_qf_PkTAPe_HHFbMd1fg5NHPClI1yrPo',
  directReferralLink: 'https://local.meetmikey.com/3/d',
  facebookReferralLink: 'https://local.meetmikey.com/3/f',
  twitterReferralLink: 'https://local.meetmikey.com/3/t',
  id: '51f1cb1eb34fd7255400000a' 
}



appInitUtils.initApp( 'imap', initActions, null, function() {
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

        imapRetrieve.getIdsOfMessagesWithAttachments (myConnection, '511', '566', [ 511, 565, 567 ], function (err, results) {

        })

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

