var constants = require ('./constants'),
    imapConnect = require ('./lib/imapConnect'),
    imapRetrieve = require ('./lib/imapRetrieve'),
    knox = require (constants.SERVER_COMMON + '/lib/s3Utils').client,
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    http = require ('http'),
    https = require ('https'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect'),
    conf = require (constants.SERVER_COMMON + '/conf'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    async = require ('async'),
    xoauth2 = require("xoauth2"),
    xoauth2gen;


winston.info("mikeymail daemon started")

sqsConnect.pollMailDownloadQueue(function (message, callback) {

  console.log ('got poll queue message', message)
  var userInfo = JSON.parse (message)

  var userId = userInfo._id

  console.log (userInfo)
  console.log ('secret', conf.google.appSecret)
  console.log ('appid', conf.google.appId)

  xoauth2gen = xoauth2.createXOAuth2Generator({
      user: userInfo.email,
      clientId: conf.google.appId,
      clientSecret: conf.google.appSecret,
      accessToken : userInfo.accessToken,
      refreshToken: userInfo.refreshToken
  });

  // SMTP/IMAP
  xoauth2gen.getToken(function(err, token){
    if(err){
      winston.log('error', 'Error: could not generate xoauth token', { err: err });
    }
    else {
   
      // trigger downloading
      var connection = imapConnect.createImapConnection (userInfo.email, token)
      imapConnect.openMailbox (connection, function (err) {
        winston.info ('connection opened for user: ' + userInfo.email)
      
        async.parallel([
          function(asyncCb){ 
            imapRetrieve.getMessagesWithAttachments (connection, 'Jan 1, 2012', userId, function (err) {

              // TODO: delete message later
              asyncCb (null, 'attachments')

            })
          },
          function(asyncCb){
            imapRetrieve.getAllMessagesForLinks (connection, 'Jan 1, 2012', userId, function (err) {

              asyncCb(null, 'links')
            })

          }
        ],
        // optional callback
        function(err, results){
          // the results array will equal ['one','two'] even though
          // the second function had a shorter timeout.
          if (err) {

          }
          else {
            callback (null)
          }

        });


      })

    }
  });


}, constants.MAX_DOWNLOAD_JOBS)