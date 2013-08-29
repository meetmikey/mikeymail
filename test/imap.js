var serverCommon = process.env.SERVER_COMMON;
var appInitUtils = require(serverCommon + '/lib/appInitUtils')
    , imapConnect = require ('../lib/imapConnect')
    , daemonUtils = require ('../lib/daemonUtils')
    , fs = require ('fs')
    , winston = require (serverCommon + '/lib/winstonWrapper').winston
    , util = require ('util')
    , Imap = require ('imap')
    , xoauth2 = require("xoauth2")
    , mailUtils = require (serverCommon + '/lib/mailUtils')
    , UserModel = require (serverCommon + '/schema/user').UserModel
    , imapRetrieve = require ('../lib/imapRetrieve');

var initActions = [
  appInitUtils.CONNECT_MONGO
];

//ObjectId("521d38054e078def1a00000a")

appInitUtils.initApp( 'imap', initActions, null, function() {
  UserModel.findById ("521d38054e078def1a00000a", function (err, userInfo) {

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

        /*
      var fetch = myConnection.fetch('63999', { bodies: [''], size: true });

      fetch.on ('message', function (msg, uid) {
        console.log ('got message', uid)
        var buffer = '', count = 0;

        msg.on('body', function (stream, info) {
          stream.on('data', function(chunk) {
            count += chunk.length;
            buffer += chunk.toString('binary');
          });
        });

        msg.on ('end', function() {
          fs.writeFileSync ('myfile', buffer);
        })

      })*/

        var fetch = myConnection.fetch('7', {
          bodies: 'HEADER.FIELDS (MESSAGE-ID FROM TO CC BCC DATE)',
          size: true
        });

        console.log ("ABOUT TO FETCH")

        fetch.on ('message', function (msg, uid) {
          console.log ('FETCH ON MESSAGE')

          msg.on('body', function (stream, info) {
            var buffer = '', count = 0;

            stream.on('data', function(chunk) {
              count += chunk.length;
              buffer += chunk.toString('utf8'); //TODO: binary?
            });


            stream.once('end', function() {
              if (info.which !== 'TEXT') {
                var hdrs = Imap.parseHeader (buffer);
                mailUtils.normalizeAddressArrays (hdrs);
                console.log ('parsedheaders', hdrs)
                console.log ('ALL RECIPIENTS', mailUtils.getAllRecipients (hdrs))
              }
            });
          });

        })

        fetch.on ('end', function () { 
          console.log ('FETCH END')
        })


        fetch.on ('error', function (err) {
          winston.doError ('FETCH ERROR', {msg : err.message, stack : err.stack});
        });

      });
    });
  });

});

