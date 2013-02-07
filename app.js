var constants = require ('./constants'),
    imapConnect = require ('./lib/imapConnect'),
    imapRetrieve = require ('./lib/imapRetrieve'),
    knox = require (constants.SERVER_COMMON + '/lib/s3Utils').client,
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    http = require ('http'),
    https = require ('https'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    conf = require (constants.SERVER_COMMON + '/conf'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    async = require ('async'),
    xoauth2 = require("xoauth2"),
    xoauth2gen;

var MailBox = mongoose.model ('MailBox')
var MailModel = mongoose.model ('Mail')

winston.info("mikeymail daemon started")

sqsConnect.pollMailDownloadQueue(function (message, pollQueueCallback) {

  console.log ('got poll queue message', message)
  var userInfo = JSON.parse (message)
  var userId = userInfo._id

  xoauth2gen = xoauth2.createXOAuth2Generator({
      user: userInfo.email,
      clientId: conf.google.appId,
      clientSecret: conf.google.appSecret,
      //accessToken : userInfo.accessToken,
      refreshToken: userInfo.refreshToken
  });

  // SMTP/IMAP
  xoauth2gen.getToken(function(err, token){
    if(err){
      winston.doError('error', 'Error: could not generate xoauth token', err);
    }
    else {
   
      // trigger downloading
      var myConnection = imapConnect.createImapConnection (userInfo.email, token)
      
      imapConnect.openMailbox (myConnection, function (err, mailbox) {

        if (err) {
          winston.doError ('Could not open mailbox', err)
        }
        else {

          winston.info ('Connection opened for user: ' + userInfo.email)
          winston.info ('Mailbox opened',  mailbox)
          
          /* sample mailbox response
          { uidnext: 2915,
            readOnly: true,
            flags: [ 'Answered', 'Flagged', 'Draft', 'Deleted', 'Seen' ],
            newKeywords: false,
            uidvalidity: 5,
            keywords: [ '' ],
            permFlags: [],
            name: '[Gmail]/All Mail',
            messages: { total: 2906, new: 0 },
            _newName: undefined }
          */

          /*
          imapConnect.closeMailbox (connection, function (err) {
            if (err) {
              winston.doError ('Could not close mailbox', err)
            }
            else {
              console.log ('mailbox closed for user ' + userInfo.email)
            }
          })
          */

          
          // assumption - initial downloading
          async.waterfall ([
            createMailbox,
            retrieveHeaders,
            retrieveAttachments,
            retrieveEmailsNoAttachments,
            markStoppingPoint,
            closeMailbox
          ], function (err) {

            if (err) {
              winston.doError ('Could not finish initial downloading', err)
            }
            else {
              pollQueueCallback (null)
            }

          });

          // create mailbox object for user
          function createMailbox (callback) {
            var box = new MailBox ({
              userId : userInfo._id,
              uidNext: mailbox.uidnext,
              uidValidity : mailbox.uidvalidity,
              name: mailbox.name,
              totalMessages : mailbox.messages.total
            })
          
            
            box.save (function (err) {
              if (err) {
                callback (err)
              } 
              else {
                var maxUid = box.uidNext - 1
                var argDict = {'mailboxId' : box._id, 'userId' : userInfo._id, 'maxUid' : maxUid, 'totalBandwith' : 0}
                callback (null, argDict)
              }             
            })
            
            /*
            var maxUid = box.uidNext - 1
            var argDict = {'mailboxId' : box._id, 'userId' : userInfo._id, 'maxUid' : maxUid}

            callback (null, argDict)
            */
          }


          function retrieveHeaders (argDict, callback) {
            
            // get all headers from the first email to the uidNext when we created the mailbox (non-inclusive)
            imapRetrieve.getHeaders(myConnection, argDict.userId, argDict.mailboxId, argDict.maxUid, function (err) {

              if (err) {
                callback (err)
              }
              else {
                callback (null, argDict)
              }
            })
            

          }

          function retrieveAttachments (argDict, callback) {
 

            imapRetrieve.getMessagesWithAttachments (myConnection, argDict.userId, argDict.maxUid, argDict.totalBandwith,
              function (err, bandwithUsed) {

                argDict.totalBandwith += bandwithUsed
                console.log (argDict)
                callback (null, argDict)

              })
 
          }

          function retrieveEmailsNoAttachments (argDict, callback) {



            // query database for messages without an s3Path
            MailModel.find ({s3Path : {$exists : false}, userId : argDict.userId})
              .select('uid _id')
              .sort ('-uid')
              .limit (100)
              .exec (function (err, messages) {
                console.log (messages)
              })

            callback (null, argDict)

          }

          function markStoppingPoint (argDict, callback) {
            callback (null, argDict)

          }

          function closeMailbox (argDict, callback) {
            imapConnect.closeMailbox (myConnection, function (err) {
              if (err) {
                winston.doError ('Could not close mailbox', err)
              }
              else {
                winston.info ('mailbox closed for user ' + userInfo.email)
                callback (null)
              }
            })
          }



          /*

          async.parallel([
            function(asyncCb){ 
              if (getAttachments) {
                imapRetrieve.getMessagesWithAttachments (connection, 'Jan 1, 2012', userId, function (err) {

                  // TODO: delete message later
                  asyncCb (null, 'attachments')

                })
              }
              else {
                asyncCb (null, 'attachments')
              }
            },
            function(asyncCb){
              if (getAllMessages) {           
                //imapRetrieve.getAllMessages (connection, 'Jan 1, 2012', userId, function (err) {
                imapRetrieve.getHeaders (connection, 'Jan 1, 2013', userId, function (err) {
                  asyncCb(null, 'links')
                })
              }
              else {
                asyncCb(null, 'links')
              }

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
          */

        }

      })

    }
  });


}, constants.MAX_DOWNLOAD_JOBS)