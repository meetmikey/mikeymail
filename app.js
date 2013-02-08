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
var UserOnboardingStateModel = mongoose.model ('UserOnboardingState')

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

  // mark state
  var state = new UserOnboardingStateModel({
    userId : userInfo._id,
    lastCompleted : 'gmailScrapeDequeued'
  })

  state.save (function (err) {
    if (err) {
      winston.doError('Error: could not save state for user ' + userInfo._id, err);
    }
    else {
      scrapeMailbox (state._id)
    }
  })

  function scrapeMailbox (onboardingStateId) {

    // SMTP/IMAP
    xoauth2gen.getToken(function(err, token){
      if(err){
        winston.doError('Error: could not generate xoauth token', err);
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
                updateErrorState (onboardingStateId, err)
              }
              else {
                pollQueueCallback ()
                winston.info ('Finished initial downloading for user ' + userInfo.email)
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
                  
                  var argDict = {
                    'mailboxId' : box._id, 
                    'userId' : userInfo._id, 
                    'maxUid' : maxUid, 
                    'totalBandwith' : 0, 
                    'attachmentBandwith' : 0, 
                    'otherBandwith' : 0
                  }

                  updateState (onboardingStateId, 'createMailbox', function () {
                    callback (null, argDict)
                  })

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

                  updateState (onboardingStateId, 'retrieveHeaders', function () {
                    callback (null, argDict)
                  })

                }
              })

            }

            function createTempDirectoryForEmails (argDict, callback) {
              winston.info ('createTempDirectoryForEmails')

              var dir = constants.TEMP_FILES_DIR + '/' + argDict.userId

              //check existence
              fs.exists(dir, function (exists) {
                if (exists) {

                  updateState (onboardingStateId, 'createTempDirectoryForEmails', function () {
                    callback (null, argDict)
                  })

                }
                else {
                  fs.mkdir (dir, function (err) {

                    if (err) {
                      winston.error ("Error: could not make directory", constants.TEMP_FILES_DIR + '/' + userId)
                      callback (err)
                    }
                    else {

                      updateState (onboardingStateId, 'createTempDirectoryForEmails', function () {
                        callback (null, argDict)
                      })

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
                      else {
                        winston.info (numAffected)
                        
                        var query = {hasAttachment : true, userId : argDict.userId, s3Path : {$exists : false}}
                        var isAttachment = true

                        retrieveBatchRecurse (myConnection, query, argDict, argDict.maxUid, isAttachment, function (err) {
                          if (err) {
                            winston.doError ('Error recursively getting attachments', err)                          
                          }

                          updateState (onboardingStateId, 'retrieveAttachments', function () {
                            callback (null, argDict)
                          })

                        })
                      }
                    })
                }
              })

            }

            function retrieveEmailsNoAttachments (argDict, callback) {
              winston.info ('retrieveEmailsNoAttachments')

              var totalBandwith = argDict.totalBandwith
              console.log (totalBandwith)
              console.log (argDict)

              if (totalBandwith < constants.MAX_BANDWITH_TOTAL) {

                var query = {s3Path : {$exists : false}, hasAttachment : {$ne : true}, userId : argDict.userId}
                var isAttachment = false

                retrieveBatchRecurse (myConnection, query, argDict, argDict.maxUid, isAttachment, function (err) {
                  if (err) {
                    winston.doError ('Error recursively getting attachments', err)                          
                  }

                  updateState (onboardingStateId, 'retrieveEmailsNoAttachments', function () {
                    callback (null, argDict)
                  })


                })

              }
              else {
                winston.info('retrieveEmailsNoAttachments: Not retrieving emails anymore \
                  because bandwith limit exceeded', totalBandwith)

                updateState (onboardingStateId, 'retrieveEmailsNoAttachments', function () {
                  callback (null, argDict)
                })

              }


            }

            function markStoppingPoint (argDict, callback) {

              updateState (onboardingStateId, 'markStoppingPoint', function () {
                callback (null, argDict)
              })

            }

            function closeMailbox (argDict, callback) {
              imapConnect.closeMailbox (myConnection, function (err) {
                if (err) {
                  winston.doError ('Could not close mailbox', err)
                }
                else {
                  winston.info ('mailbox closed for user ' + userInfo.email)

                  updateState (onboardingStateId, 'closeMailbox', function () {
                    callback (null)
                  })

                }
              })
            }

          }

        })

      }
    });
  }

}, constants.MAX_DOWNLOAD_JOBS)

function updateState (stateId, newState, cb) {
  UserOnboardingStateModel.update ({_id : stateId}, {$set : {lastCompleted : newState}}, 
    function (err, numAffected) {
      if (err) {
        winston.doError ('Error updating user state with id ' + stateId, err)
      }
      else if (numAffected == 0) {
        winston.error ('Zero records affected when updating user state with id ' + stateId)
      }

      cb()
    })
}

function updateErrorState (stateId, errorMsg) {
  UserOnboardingStateModel.update ({_id : stateId}, {$set : {errorMsg : errorMsg, hasError : true}}, 
    function (err, numAffected) {
      if (err) {
        winston.doError ('Error updating user state with id ' + stateId, err)
      }
      else if (numAffected == 0) {
        winston.error ('Zero records affected when updating user state with id ' + stateId)
      }
    })
}

function retrieveBatchRecurse (myConnection, query, argDict, maxUid, isAttachment, callback) {

  console.log ('maxUid', maxUid)

  // query database for messages that are attachments
  MailModel.find (query)
    .where('uid').lte(maxUid)
    .select('uid')
    .sort ('-uid')
    .limit (constants.EMAIL_FETCH_BATCH_SIZE)
    .exec (function (err, messages) {
      if (err) {
        callback (err)
      }
      else {
        
        console.log (messages)

        var msgLength = messages.length
        
        if (!msgLength) {
          return callback ()
        }

        // last element of array, minus 1 so we don't redo the current last msg
        var newMaxUid = messages[msgLength - 1].uid - 1

        imapRetrieve.getMessagesByUid (myConnection, argDict.userId, 
          messages, function (err, bandwithUsed) {
          
          if (err) {
            //TODO: ... don't fail whole chain???
            callback (err)
          }
          else {
            argDict.totalBandwith += bandwithUsed

            if (isAttachment) {
              argDict.attachmentBandwith += bandwithUsed
            }
            else {
              argDict.otherBandwith += bandwithUsed
            }

            console.log ('totalBandwith', argDict.totalBandwith)
            if (msgLength < constants.EMAIL_FETCH_BATCH_SIZE || newMaxUid < 1) {
              winston.info('retrieveBatchRecurse: Not retrieving emails anymore: no emails left to process with isAttachment: ', isAttachment)
              callback ()
            }
            else if (argDict.totalBandwith < constants.MAX_BANDWITH_TOTAL) {

              // sub-conditions for isAttachment
              if (isAttachment && argDict.attachmentBandwith > constants.MAX_BANDWITH_ATTACHMENT) {
                winston.info('retrieveBatchRecurse: Not retrieving emails anymore: attachment bandwith used up: ', argDict.attachmentBandwith)
                callback (null)
              }
              else {
                retrieveBatchRecurse (myConnection, query, argDict, newMaxUid, isAttachment, callback)
              }

            }
            else {
              winston.info('retrieveBatchRecurse: Not retrieving emails anymore: bandwith used up: ', argDict.totalBandwith)
              callback (null)
            }
          
          }

        })
      }
    })
}