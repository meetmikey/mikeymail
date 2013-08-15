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

appInitUtils.initApp( 'imap', initActions, null, function() {
  UserModel.findById ("52047ed15974ce186e004d66", function (err, userInfo) {

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

