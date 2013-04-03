var serverCommon = process.env.SERVER_COMMON;

var Imap = require('imap'),
    inspect = require('util').inspect,
    constants = require ('../constants'),
    conf = require (serverCommon + '/conf'),
    fs = require('fs'),
    mailUtils = require (serverCommon + '/lib/mailUtils'),
    mongoUtils = require(serverCommon + '/lib/mongoUtils'),
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose,
    ObjectId = mongoose.Types.ObjectId,
    async = require ('async'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    uploadUtils = require ('./uploadUtils');
    
var MailModel = mongoose.model ('Mail');
var UserOnboardingStateModel = mongoose.model ('UserOnboardingState');
var imapRetrieve = this;

exports.imapSearch = function (imapConn, criteria, callback) {

  imapConn.search(criteria, function(err, results) {
    callback (err, results)
  })

}

exports.getHeadersInBatches = function (imapConn, userId, mailboxId, minUid, maxUid, onboardingStateId, inRecoveryMode, folderNames, callback) {

  var numIntervals = Math.ceil(maxUid/constants.HEADER_BATCH_SIZE);
  winston.info ('getHeadersInBatches with ' + numIntervals + ' intervals');
  var asyncFunctionArguments = [];

  imapRetrieve.getHeaderSkipIntervals (onboardingStateId, inRecoveryMode, function (err, intervalsToSkip) {

    if (err) {
      callback (winston.makeMongoError (err, {onboardingStateId : onboardingStateId}));
      return;
    }

    // set up the intervals
    for (var i = 0; i < numIntervals; i++) {
      var minUidBatch = minUid + i*constants.HEADER_BATCH_SIZE;
      var maxUidBatch = Math.min((i+1)*constants.HEADER_BATCH_SIZE, maxUid);

      if (intervalsToSkip && intervalsToSkip.length) {
        var pushToAsync = true;

        intervalsToSkip.forEach (function (interval) {
          //TODO: be less strict
          if (minUidBatch == interval.minUid && maxUidBatch == interval.maxUid) {
            // don't push on async
            pushToAsync = false;
          }
        });

        if (pushToAsync) {
          winston.info ('not skipping the following batch', {minUid : minUidBatch, maxUid : maxUidBatch});

          asyncFunctionArguments.push ({
            'imapConn' : imapConn, 
            'userId': userId, 
            'mailboxId' : mailboxId, 
            'minUidBatch' : minUidBatch, 
            'maxUidBatch' : maxUidBatch, 
            'onboardingStateId': onboardingStateId,
            'folderNames' : folderNames
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
          'onboardingStateId': onboardingStateId,
          'folderNames' : folderNames
        });
      }
    }

    // all done
    async.forEachSeries (asyncFunctionArguments, function (args, asyncCb) {
      imapRetrieve.getHeaders (args.imapConn, args.userId, args.mailboxId, args.minUidBatch, args.maxUidBatch, 
        args.onboardingStateId, args.folderNames, asyncCb);
    }, 
    function (err, results) {
      if (err) {
        winston.doError ('Could not get all batches', {err : err});
        callback (err);
      } 
      else {
        winston.info ('asyncForEach series calling back');
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

exports.getHeaders = function (imapConn, userId, mailboxId, minUid, maxUid, onboardingStateId, folderNames, callback) {

  winston.doInfo ('getHeaders', {minUid : minUid, maxUid:maxUid});

  var currentLength = 0;

  if (!minUid || !maxUid || (maxUid != '*' && minUid > maxUid)) {
    return callback (winston.makeError ('getHeaders validation error: minUid, maxUid invalid', 
      {userId : userId, stateId : onboardingStateId, minUid : minUid, maxUid : maxUid}));
  }

  var uidRange = minUid + ':' + maxUid;

  try {

    imapConn.fetch(uidRange,
      {size : true}, 
      { headers: ['message-id', 'from', 'to', 'cc', 'bcc'],
        cb: function(fetch) {

          var docs = [];

          fetch.on('message', function(msg) {
            //winston.doInfo ('imap header', {msg : msg})
            

            var mailObject = {
              'userId' : userId,
              'mailboxId' : mailboxId,
              'shardKey': mongoUtils.getShardKeyHash( userId )
            }

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
                mailObject.gmThreadId = msg['x-gm-thrid'];
              }

              if (msg['x-gm-msgid']) {
                mailObject.gmMsgId = msg['x-gm-msgid'];
              }

              if (msg['x-gm-labels']) {
                mailObject.gmLabels = [];

                msg['x-gm-labels'].forEach (function (label) {
                  mailObject.gmLabels.push (label);
                })

              }


              if (!imapRetrieve.checkLabelIsInvalid (mailObject, folderNames)) {
                docs.push (mailObject);
                currentLength += 1;
              }

            });

          });


          fetch.on ('end', function () {
            winston.info ('FETCH END', {minUid : minUid, maxUid : maxUid});

            var result = {minUid : minUid, maxUid : maxUid, numMails : currentLength};

            if (docs.length == 0) {
              imapRetrieve.updateOnboardingStateModelWithHeaderBatch (onboardingStateId, result);
              callback (null, result);
              return;
            }

            MailModel.collection.insert (docs, function (err) {
              
              if (err && err.code == 11000){
                imapRetrieve.updateOnboardingStateModelWithHeaderBatch (onboardingStateId, result);
                callback (null, result);
              }
              else if (err) {
                winston.doError ('Error from mongo bulk insert', {err : err});
                callback (winston.makeError ('Error from bulk insert', {err : err}));
              }
              else {
                imapRetrieve.updateOnboardingStateModelWithHeaderBatch (onboardingStateId, result);
                callback (null, result);
              }

            });


          });

        }
      }, 
      //TODO: make sure err would be called before fetch.on ('end') otherwise we'll double callback
      function(err) {
        if (err) {
          callback (err);
        }
      });
    } catch (err) {
      winston.doError ('Caught error getHeaders', {stack : err.stack, message : err.message});
      callback (err);
    }
}


exports.checkLabelIsInvalid = function (mailObject, folderNames) {  
  var isInvalid = false;

  var skipLabels = [];

  if (!folderNames) {
    winston.doError ('Folder names have not been extracted!');
    return isInvalid;
  }

  if (folderNames['TRASH']) {
    var name = folderNames['TRASH'].toLowerCase();
    skipLabels.push (name);
    skipLabels.push (name.substring (0, name.length-1));
  }
  
  if (folderNames['DRAFTS']) {
    var name = folderNames['DRAFTS'].toLowerCase();
    skipLabels.push (name);
    skipLabels.push (name.substring (0, name.length-1));
  }

  if (folderNames ['SPAM']) {
    var name = folderNames['SPAM'].toLowerCase();
    skipLabels.push (name);
    skipLabels.push (name.substring (0, name.length-1));  
  }

  // sanity check
  if (skipLabels.length == 0) {
    winston.doWarn ('checkLabelIsInvalid - skipLabels has no length');
    return isInvalid;
  }

  if (mailObject.gmLabels && mailObject.gmLabels.length) {

    mailObject.gmLabels.forEach (function (label) {

      if (typeof label == "string") {
        // remove trailing and forward slashes
        var labelStripped = label.replace(/\/+$/, "").replace(/\\+$/, "").replace (/^\/+/, "").replace (/^\\+/, "").toLowerCase();

        // check if it's a draft or trash or spam
        if (skipLabels.indexOf (labelStripped) != -1) {
          isInvalid = true;
        }
      }

    });
  }

  return isInvalid;
}

exports.updateOnboardingStateModelWithHeaderBatch = function (onboardingStateId, result) {  
  if (onboardingStateId) {        
    UserOnboardingStateModel.update ({_id : onboardingStateId}, 
      {$push : {headerBatchesComplete : result}},
      function (err, num) {
        if (err) {
          winston.doError ('Could not update onboarding state with complete batch', {err : err});
        }
        else if (num === 0) {
          winston.doError ('zero records affected error', {onboardingStateId : onboardingStateId});
        }
        else {
          winston.doInfo ('updated onboarding state with completed batch', {minUid : result.minUid, maxUid : result.maxUid, numMails : result.numMails});
        }
      });
  }
}

exports.getUpdates = function (imapConn, minUid, callback) {

  winston.info ('getUpdates')
  var msgIds = []

  var currentLength = 0
  var uidRange = minUid + ':*'

  try {

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
  } catch (e) {
    winston.doError ('imap conn fetch error', {message : e.message, stack : e.stack});
    callback (e);
  }

}


exports.fetchBoxesToStayAlive = function (imapConn, userId) {
  winston.info ('fetchBoxesToStayAlive fetch', {userId : userId})

  try {
    imapConn.getBoxes ('dummyprefix', function (getBoxesErr, boxes) {
      if (getBoxesErr) {
        winston.doWarn ('fetchBoxesToStayAlive', {getBoxesErr : getBoxesErr});
      }
    });
  } catch (err) {
    winston.doError ('Caught error fetchBoxesToStayAlive', {stack : err.stack, message : err.message});
  }

}


exports.getIdsOfMessagesWithAttachments = function (imapConn, minUid, maxUid, callback) {
  var uidRange = imapRetrieve.getUidRangeString(minUid, maxUid)

  imapConn.search([ ['X-GM-RAW', 'has:attachment'], ['UID', uidRange]], function(err, results) {
    callback (err, results)
  })

}

exports.getMessagesByUid = function (imapConn, userId, messages, isUpdate, getAllMessagesCallback) {
  winston.doInfo ('getMessagesByUid', {userId : userId});

  var messageIds = messages.map (function (elem) { return elem.uid})

  if (messageIds.length === 0) {
    getAllMessagesCallback (null, 0)
  }
  else {
    imapRetrieve.fetchMsgBodies (imapConn, messageIds, userId, isUpdate, getAllMessagesCallback)
  }

}

exports.getMarketingTextIds = function (imapConn, minUid, maxUid, callback) {  
  var uidRange = imapRetrieve.getUidRangeString(minUid, maxUid)

  imapConn.search([ ['X-GM-RAW', constants.MARKETING_TEXT], ['UID', uidRange]], function(err, results) {
    callback (err, results)
  })

}


exports.getMarketingFromIds = function (imapConn, minUid, maxUid, callback) {
  var uidRange = imapRetrieve.getUidRangeString(minUid, maxUid)

  imapConn.search([ ['X-GM-RAW', constants.MARKETING_FROM], ['UID', uidRange]], function(err, results) {
    callback (err, results)
  })

}

// accepts an array of uids and returns the bandwith used
exports.fetchMsgBodies = function (imapConn, uidArray, userId, isUpdate, getAllMessagesCallback) {
  winston.doInfo ('fetchMsgBodies', {userId : userId});

  var cloudDirectory;

  if (constants.USE_AZURE) {
    cloudDirectory = conf.azure.blobFolders.rawEmail + '/' + userId;
  }
  else {
    cloudDirectory = conf.aws.s3Folders.rawEmail + '/' + userId;
  }

  var bandwithUsed = 0;

  try {

    imapConn.fetch(uidArray,
      {size : true},
      { body: true,
        headers: { parse: false },
        cb: function(fetch) {
          fetch.on('message', function(msg) {

            var buffer = '';

            msg.on('data', function(chunk) {
              buffer += chunk.toString ('binary');
            });
            
            msg.on('end', function() {
              bandwithUsed += msg.size;
            
              var headers = {
                'Content-Type': 'text/plain',
                'x-amz-server-side-encryption' : 'AES256'
              }

              var cloudPath = cloudDirectory + '/' + msg.uid + '-body.txt';

              // allowed to happen asynchronously
              uploadUtils.uploadBufferToCloud (buffer, cloudPath, headers, userId, msg.uid, isUpdate);

            });

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

  } catch (err) {
    winston.doError ('Caught error getMsgBodies', {stack : err.stack, message : err.message});
    getAllMessagesCallback (err);
  }

}


// local helper functions
exports.getUidRangeString = function (minUid, maxUid) {
  return minUid + ':'  + maxUid;
}
