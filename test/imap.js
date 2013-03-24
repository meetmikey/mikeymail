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
    "refreshToken" : "1/srvJTjuAVgLuPHGQAu9lwu93zoDHGFDombaRz-PreNg",
    "timestamp" : "2013-03-15T00:03:37.728Z"
  }

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

        // fetch some messages
        imapRetrieve.getMessagesByUid (myConnection, userInfo._id, [{uid : '1070'}], false, function (err, bandwith) {
          if (err) {
            winston.doError (err);
          }
          else {
            winston.info ('all messages callback with bandwith used', bandwith);
          }
        });

    });

  });


});

