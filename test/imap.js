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
  "shortId" : "1",
  "googleID" : "115882407960585095714",
  "accessHash" : "0aa51b7b174318a6437c35a6401238a34c43e10df73eb5b9d86c9599530aff5ef76370a8885119e68bf0ce2f91eef4500ce9b3330cd432b97aee5ba73196c651",
  "displayName" : "Sagar Mehta",
  "firstName" : "Sagar",
  "lastName" : "Mehta",
  "email" : "sagar@mikeyteam.com",
  "locale" : "en",
  "hostedDomain" : "mikeyteam.com",
  "expiresAt" : "2013-08-05T19:10:43.999Z",
  "symHash" : "1e9d392306eb25b161f4ea41172821b8b035d98aeaa462a8f400266bc64b91bb0437d5f763703b90052306326a02ad2335fda3d43b58b4617fbd3ad9f5e7d4d5",
  "symSalt" : "a954e94e3302046f",
  "asymHash" : "$2a$08$vA1D6sYxvHzHlg9yVzmCQuu20VGMcUwMiSIdj3fbH4hGl4FJTzVtK",
  "asymSalt" : "$2a$08$vA1D6sYxvHzHlg9yVzmCQu",
  "_id" : "51ffeaa4820a4a7a1700000a",
  "lastResumeJobEndDate" : "2013-08-05T18:10:44.024Z",
  "billingPlan" : "free",
  "isPremium" : false,
  "daysLimit" : 90,
  "allMailOnboardAttempts" : 0,
  "minMailDate" : "2013-08-05T18:10:44.024Z",
  "minMRProcessedDate" : "2013-08-05T18:10:44.024Z",
  "minProcessedDate" : "2013-08-05T18:10:44.024Z",
  "timestamp" : "2013-08-05T18:10:44.024Z",
  "invalidToken" : false,
  "gmailScrapeRequested" : true,
  "__v" : 0
}



appInitUtils.initApp( 'imap', initActions, null, function() {
  UserModel.findById ("52002b49a108c2a729000010", function (err, userInfo) {

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
      imapConnect.openMailbox (myConnection, userInfo.email, function (err, mailbox) {

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

        var uploadsDone = [];
        var onMessageEvents = [];
        var fetch = myConnection.fetch('96', {bodies: [''], size: true });

        fetch.on ('message', function (msg, seqno) {
          onMessageEvents.push (seqno)
          console.log ('on message len', onMessageEvents.length)

          var buffer = '', count = 0;

          msg.on('body', function (stream, info) {
            stream.on('data', function(chunk) {
              count += chunk.length;
              buffer += chunk.toString('binary');
            });
          });

          msg.on('attributes', function(attrs) {
            console.log ('attributes function called', attrs);
            msg.uid = attrs.uid;
            msg.size = attrs.size;
          });

          msg.on('end', function() {
            console.log ('MSG END EVENT');
            console.log ('end function called', msg.uid);
            uploadsDone.push (msg.uid);
            console.log ('message end uploads length', uploadsDone.length);

          });
        });


        fetch.on ('end', function () {
          console.log ('FETCH END EVENT');
          console.log ('fetch end uploads length', uploadsDone.length);

          //getAllMessagesCallback (null, bandwithUsed);
        });

        fetch.on ('error', function (err) {
          console.log ('fetch on error');

          //getAllMessagesCallback (winston.makeError ('error fetching mail bodies', {err : err}));
        });


      });
    });
  });

});

