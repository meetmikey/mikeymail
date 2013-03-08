var Imap = require('imap'),
    inspect = require('util').inspect,
    constants = require ('../constants'),
    conf = require (constants.SERVER_COMMON + '/conf'),
    fs = require('fs'),
    mailUtils = require (constants.SERVER_COMMON + '/lib/mailUtils'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    async = require ('async'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    uploadUtils = require ('./uploadUtils');
    
var MailModel = mongoose.model ('Mail');
var UserOnboardingStateModel = mongoose.model ('UserOnboardingState');
var imapRetrieve = this;

exports.imapSearch = function (imapConn, criteria, callback) {

  imapConn.search(criteria, function(err, results) {
    callback (err, results)
  })

}

exports.getHeadersInBatches = function (imapConn, userId, mailboxId, minUid, maxUid, onboardingStateId, inRecoveryMode, callback) {
  var numIntervals = Math.ceil(maxUid/constants.HEADER_BATCH_SIZE);
  winston.info ('getHeadersInBatches with ' + numIntervals + ' intervals');
  var asyncFunctionArguments = [];

  imapRetrieve.getHeaderSkipIntervals (onboardingStateId, inRecoveryMode, function (err, intervalsToSkip) {

    if (err) {
      callback (winston.makeMongoError (err, {onboardingStateId : onboardingStateId}));
      return;
    }

    winston.info ('intervalsToSkip', intervalsToSkip);

    // set up the intervals
    for (var i = 0; i < numIntervals; i++) {
      var minUidBatch = minUid + i*constants.HEADER_BATCH_SIZE;
      var maxUidBatch = Math.min((i+1)*constants.HEADER_BATCH_SIZE, maxUid);
      winston.info ('minUidBatch', minUidBatch);
      winston.info ('maxUidBatch', maxUidBatch);

      if (intervalsToSkip && intervalsToSkip.length) {
        var pushToAsync = true;

        intervalsToSkip.forEach (function (interval) {
          if (minUidBatch >= interval.minUid && maxUidBatch <= interval.maxUid) {
            // don't push on async
            pushToAsync = false;
          }
        })

        if (pushToAsync) {
          asyncFunctionArguments.push ({
            'imapConn' : imapConn, 
            'userId': userId, 
            'mailboxId' : mailboxId, 
            'minUidBatch' : minUidBatch, 
            'maxUidBatch' : maxUidBatch, 
            'onboardingStateId': onboardingStateId
          });
        }

      }
      else {
        asyncFunctionArguments.push ({
          'imapConn' : imapConn, 
          'userId': userId, 
          'mailboxId' : mailboxId, 
          'minUidBatch' : minUidBatch, 
          'maxUidBatch' : maxUidBatch, 
          'onboardingStateId': onboardingStateId
        });
      }

    }

    // all done
    async.forEachSeries (asyncFunctionArguments, function (args, asyncCb) {
      imapRetrieve.getHeaders (args.imapConn, args.userId, args.mailboxId, args.minUidBatch, args.maxUidBatch, args.onboardingStateId, asyncCb);
    }, 
    function (err, results) {
      if (err) {
        winston.doError ('Could not get all batches', {err : err});
        callback (err);
      } 
      else {
        callback (null, results);
      }
    });

  });

}

exports.getHeaderSkipIntervals = function (onboardingStateId, inRecoveryMode, callback) {
  var intervalsToSkip = [];

  if (!inRecoveryMode) {
    callback (null, intervalsToSkip);
  }
  else {
    UserOnboardingStateModel.findById (onboardingStateId, function (err, onboardingState) {
      if (err) {
        callback(winston.makeMongoError (err, {onboardingStateId : onboardingStateId}));
      }
      else if (!onboardingState) {
        callback(winston.makeError ('could not find onboarding state', {onboardingStateId : onboardingStateId}));        
      }
      else {
        intervalsToSkip = onboardingState.headerBatchesComplete;        
        callback (null, intervalsToSkip);
      }
    });
  }

}

exports.getHeaders = function (imapConn, userId, mailboxId, minUid, maxUid, onboardingStateId, callback) {
  // TODO: see if we need to insert x records at a time 
  // var maxRecords = constants.OBJECTS_PER_MAIL_INSERT
  winston.doInfo ('getHeaders', {minUid : minUid, maxUid:maxUid});

  var currentLength = 0;
  uidRange = minUid + ':' + maxUid;

  try {

    imapConn.fetch(uidRange,
      {size : true}, 
      { headers: ['message-id', 'from', 'to', 'cc', 'bcc'],
        cb: function(fetch) {

          fetch.on('message', function(msg) {
            //winston.doInfo ('imap header', {msg : msg})
            
            var mailObject = new MailModel ({
              'userId' : userId,
              'mailboxId' : mailboxId
            })

            msg.on('headers', function(hdrs) {
              mailUtils.normalizeAddressArrays (hdrs);
              mailObject ['messageId'] = hdrs['message-id'];
              mailObject ['sender'] = mailUtils.getSender (hdrs);
              mailObject ['recipients'] = mailUtils.getAllRecipients (hdrs);
            });

            msg.on('end', function() {

              mailObject ['uid'] = msg.uid;
              mailObject ['seqNo'] = msg.seqno;
              mailObject ['size'] = msg.size;

              if(msg['date']) {
                mailObject['gmDate'] = new Date( Date.parse( msg['date'] ) );
              }

              if (msg['x-gm-thrid']) {
                mailObject.gmThreadId = msg['x-gm-thrid']
              }

              if (msg['x-gm-msgid']) {
                mailObject.gmMsgId = msg['x-gm-msgid']
              }

              if (msg['x-gm-labels']) {
                mailObject.gmLabels = []

                msg['x-gm-labels'].forEach (function (label) {
                  mailObject.gmLabels.push (label)
                })

              }

              mailObject.save (function (err) {
                if (err && err.code == 11000) {
                  winston.doInfo ('Mail saved fail due to duplicate key', {uid : msg.uid, userId : userId});
                }
                else if (err) {
                  winston.doError ('Could not save mail object', err);
                }
              })
              
              currentLength += 1;

            });     

          });
        }
      }, 
      function(err) {
        if (onboardingStateId) {        
          UserOnboardingStateModel.update ({_id : onboardingStateId}, 
            {$push : {headerBatchesComplete : {minUid : minUid, maxUid : maxUid}}},
            function (err, num) {
              if (err) {
                winston.doError ('Could not update onboarding state with complete batch', {err : err});
              }
              else if (num == 0){
                winston.doError ('zero records affected error', {onboardingStateId : onboardingStateId});
              }
              else {
                winston.doInfo ('updated onboarding state with completed batch', {minUid : minUid, maxUid : maxUid});
              }
            });
        }

        callback (err, {minUid : minUid, maxUid : maxUid});
      });
    } catch (err) {
      winston.doError ('Caught error getHeaders', {err : err});
      callback (err);
    }
}


exports.getUpdates = function (imapConn, minUid, callback) {

  winston.info ('getUpdates')
  var msgIds = []

  var currentLength = 0
  uidRange = minUid + ':*'

  imapConn.fetch(uidRange,
    {size : false},
    { headers: false,
      cb: function(fetch) {

        fetch.on('message', function(msg) {
         
          msg.on('end', function() {
            console.log  (msg)
            msgIds.push  (msg.uid)
            currentLength += 1

          });   

        });
      }
    }, 
    function(err) {
      if (err) {
        callback (err);
      }
      else {
        callback (null, msgIds);
      }
    });

}





exports.getIdsOfMessagesWithAttachments = function (imapConn, minUid, maxUid, callback) {
  var uidRange = getUidRangeString(minUid, maxUid)

  imapConn.search([ ['X-GM-RAW', 'has:attachment'], ['UID', uidRange]], function(err, results) {
    callback (err, results)
  })

}

exports.getMessagesByUid = function (imapConn, userId, messages, isUpdate, getAllMessagesCallback) {

  var messageIds = messages.map (function (elem) { return elem.uid})

  if (messageIds.length === 0) {
    getAllMessagesCallback (null, 0)
  }
  else {
    imapRetrieve.fetchMsgBodies (imapConn, messageIds, userId, isUpdate, getAllMessagesCallback)
  }

}

exports.getMarketingTextIds = function (imapConn, minUid, maxUid, callback) {
  var uidRange = getUidRangeString(minUid, maxUid)

  imapConn.search([ ['X-GM-RAW', constants.MARKETING_TEXT], ['UID', uidRange]], function(err, results) {
    callback (err, results)
  })

}


exports.getMarketingFromIds = function (imapConn, minUid, maxUid, callback) {
  var uidRange = getUidRangeString(minUid, maxUid)

  imapConn.search([ ['X-GM-RAW', constants.MARKETING_FROM], ['UID', uidRange]], function(err, results) {
    callback (err, results)
  })

}

// accepts an array of uids and returns the bandwith used
exports.fetchMsgBodies = function (imapConn, uidArray, userId, isUpdate, getAllMessagesCallback) {

  var awsDirectory = constants.AWS_RAW_MSG_DIR + '/' + userId;
  var bandwithUsed = 0;

  imapConn.fetch(uidArray,
    {size : true},
    { body: true,
      headers: { parse: false },
      cb: function(fetch) {
        fetch.on('message', function(msg) {
          /*
        var awsPath = awsDirectory + '/' + msg.uid + '-body.txt'

        var headers = {
          'Content-Type': 'text/plain'
          , 'Content-Length' : msg.size
          , 'x-amz-server-side-encryption' : 'AES256'
        }

        uploadUtils.uploadFileStreamToS3(msg, 'test', headers);
          */
          //TODO: either stream the upload or do it in buffer??
          //var filename = constants.TEMP_FILES_DIR + '/' + userId + '/msg-' + msg.seqno + '-ts-' +  + Date.now() + '-body.txt';

          //fileStream = fs.createWriteStream(filename);
          var buffer = '';

          msg.on('data', function(chunk) {
            buffer += chunk.toString ('binary');
            //fileStream.write(chunk);
          });
          
          msg.on('end', function() {
            bandwithUsed += msg.size;
          
            var headers = {
              'Content-Type': 'text/plain'
              , 'x-amz-server-side-encryption' : 'AES256'
            }

            var awsPath = awsDirectory + '/' + msg.uid + '-body.txt';

            uploadUtils.uploadBufferToS3 (buffer, awsPath, headers, userId, msg.uid, isUpdate, 0);
          });

          /*
          fileStream.on('close' , function () {

            var headers = {
              'Content-Type': 'text/plain'
              , 'x-amz-server-side-encryption' : 'AES256'
            }

            var awsPath = awsDirectory + '/' + msg.uid + '-body.txt'

            uploadUtils.uploadFileToS3 (filename, awsPath, headers, userId, msg.uid, isUpdate, 0)

          })
          */

        })
      }
    }, function(err) {

      if (err) {
        getAllMessagesCallback (err)
      }
      else {
        winston.info ('all done fetching msg bodies')
        getAllMessagesCallback (null, bandwithUsed)            
      }

    })

}


// local helper functions
function getUidRangeString (minUid, maxUid) {
  return minUid + ':'  + maxUid
}
