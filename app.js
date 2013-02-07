var constants = require ('./constants'),
    imapConnect = require ('./lib/imapConnect'),
    imapRetrieve = require ('./lib/imapRetrieve'),
    knox = require (constants.SERVER_COMMON + '/lib/s3Utils').client,
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    http = require ('http'),
    https = require ('https'),
    fs = require ('fs'),
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


          
          // assumption - initial downloading
          async.waterfall ([
            createMailbox,
            retrieveHeaders,
            createTempDirectoryForEmails,
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
            winston.info ('createMailbox')

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
            
          }


          function retrieveHeaders (argDict, callback) {
            winston.info ('retrieveHeaders')

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

          function createTempDirectoryForEmails (argDict, callback) {
            winston.info ('createTempDirectoryForEmails')

            var dir = constants.TEMP_FILES_DIR + '/' + argDict.userId

            //check existence
            fs.exists(dir, function (exists) {
              if (exists) {
                callback (null, argDict)
              }
              else {
                fs.mkdir (dir, function (err) {

                  if (err) {
                    winston.error ("Error: could not make directory", constants.TEMP_FILES_DIR + '/' + userId)
                    callback (err)
                  }
                  else {
                    callback (null, argDict)
                  }

                })
              }

            })

          }

          function retrieveAttachments (argDict, callback) {
            winston.info ('retrieveAttachments')

            // get the messageIds with attachments
            imapRetrieve.getIdsOfMessagesWithAttachments (myConnection, argDict.maxUid, function (err, results) {
              if (err) {
                callback (err)
              }
              else {

                var resultsAsInt = results.map (function (elem) { return parseInt(elem)})

                console.log (resultsAsInt)
                console.log ({user : argDict.userId}) 
                
                MailModel.update ({userId : argDict.userId, 'uid' : {$in : resultsAsInt}}, 
                  {$set : {hasAttachment : true}}, 
                  {multi : true})
                  .exec(function (err, numAffected) {
                    if (err) {
                      callback (err)
                    }
                    else if (numAffected == 0) {
                      winston.error ('no records affected')
                      callback (null, argDict)
                    }
                    else {
                      winston.info (numAffected)
                      callback (null, argDict)
                    }
                  })
              }
            })

            //TODO: replace with bandwith limited attachment get like below
            imapRetrieve.getMessagesWithAttachments (myConnection, argDict.userId, argDict.maxUid, argDict.totalBandwith,
              function (err, bandwithUsed) {
                argDict.totalBandwith += bandwithUsed
                callback (null, argDict)
              })
            
          }

          function retrieveEmailsNoAttachments (argDict, callback) {
            winston.info ('retrieveEmailsNoAttachments')

            var totalBandwith = argDict.totalBandwith
            console.log (totalBandwith)
            var skip = 0

            if (totalBandwith < constants.MAX_BANDWITH_TOTAL) {          
              retrieveBatch (totalBandwith, skip)
            }
            else {
              winston.info('retrieveEmailsNoAttachments: Not retrieving emails anymore \
                because bandwith limit exceeded', totalBandwith)
              callback (null, argDict)
            }

            function retrieveBatch (totalBandwith, skip) {

              // query database for messages without an s3Path
              MailModel.find ({s3Path : {$exists : false}, userId : argDict.userId})
                .select('uid')
                .sort ('-uid')
                .skip(skip)
                .limit (constants.EMAIL_FETCH_BATCH_SIZE)
                .exec (function (err, messages) {
                  if (err) {
                    callback (err)
                  }
                  else {
                    imapRetrieve.getMessagesByUid (myConnection, argDict.userId, 
                      messages, function (err, bandwithUsed) {
                      
                      if (err) {
                        //TODO: ... don't fail whole chain???
                        callback (err)
                      }
                      else {
                        totalBandwith += bandwithUsed
                        console.log ('totalBandwith', totalBandwith)
                        if (totalBandwith < constants.MAX_BANDWITH_TOTAL 
                          && messages.length == constants.EMAIL_FETCH_BATCH_SIZE) {
                          
                          retrieveBatch (totalBandwith, skip + constants.EMAIL_FETCH_BATCH_SIZE)
                        }
                        else {
                          winston.info('retrieveEmailsNoAttachments: Not retrieving emails anymore \
                            because bandwith limit exceeded', totalBandwith)
                          callback (null, argDict)
                        }
                      
                      }

                    })
                  }
                })

            }

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

        }

      })

    }
  });


}, constants.MAX_DOWNLOAD_JOBS)