var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants'),
    mailUtils = require (serverCommon + '/lib/mailUtils'),
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose,
    async = require ('async'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston;
    
var MailModel = mongoose.model ('Mail');
var UserOnboardingStateModel = mongoose.model ('UserOnboardingState');
var imapRetrieve = this;

exports.imapSearch = function (imapConn, criteria, callback) {
  imapConn.search(criteria, function(err, results) {
    callback (err, results)
  });
}

exports.getHeadersInBatches = function (argDict, callback) {

  var minUid = argDict.minUid;
  var maxUid = argDict.maxUid;
  var onboardingStateId = argDict.onboardingStateId;
  var inRecoveryMode = argDict.recoveryMode;

  var numIntervals = Math.ceil(maxUid/constants.HEADER_BATCH_SIZE);
  winston.doInfo('getHeadersInBatches with ' + numIntervals + ' intervals');
  var asyncFunctionArguments = [];

  imapRetrieve.getHeaderSkipIntervals (onboardingStateId, inRecoveryMode, function (err, intervalsToSkip) {

      if (err) {
        callback(winston.makeMongoError (err, {onboardingStateId : onboardingStateId}));
        return;
      }

      // set up the intervals
      for (var i = 0; i < numIntervals; i++) {
        var minUidBatch = minUid + i*constants.HEADER_BATCH_SIZE;
        var maxUidBatch = Math.min((i+1)*constants.HEADER_BATCH_SIZE, maxUid);

        if (intervalsToSkip && intervalsToSkip.length) {
          var pushToAsync = true;

          intervalsToSkip.forEach (function (interval) {
            if (minUidBatch == interval.minUid && maxUidBatch == interval.maxUid) {
              // don't push on async
              pushToAsync = false;
            }
          });

          if (pushToAsync) {
            winston.doInfo('not skipping the following batch', {minUid : minUidBatch, maxUid : maxUidBatch});

            asyncFunctionArguments.push ({
              'minUidBatch' : minUidBatch,
              'maxUidBatch' : maxUidBatch
            });
          }
        }
        else {
          asyncFunctionArguments.push ({
            'minUidBatch' : minUidBatch,
            'maxUidBatch' : maxUidBatch
          });
        }
      }

      // all done
      async.forEachSeries (asyncFunctionArguments, function (args, asyncCb) {
        imapRetrieve.getHeaders (argDict, args.minUidBatch, args.maxUidBatch, asyncCb);
      },
      function (err, results) {
        if (err) {
          winston.doError ('Could not get all batches', {err : err});
          callback (err);
        } else {
          winston.doInfo ('asyncForEach series calling back');
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

exports.getHeaders = function (argDict, minUid, maxUid, callback) {

  // unpack variables
  var imapConn = argDict.imapConn;
  var userId = argDict.userId;
  var mailboxId = argDict.mailboxId;
  var onboardingStateId = argDict.onboardingStateId;
  var folderNames = argDict.folderNames;

  winston.doInfo ('getHeaders', {minUid : minUid, maxUid:maxUid});
  if (!minUid || !maxUid || (maxUid != '*' && minUid > maxUid)) {
    return callback (winston.makeError ('getHeaders validation error: minUid, maxUid invalid',
      {userId : userId, stateId : onboardingStateId, minUid : minUid, maxUid : maxUid}));
  }

  var uidRange = minUid + ':' + maxUid;

  imapConn.fetch(uidRange,
    {size : true},
    { headers: ['message-id', 'from', 'to', 'cc', 'bcc'],
      cb: function(fetch) {

        // mail objects to be written to the databas
        var docsToSave = [];

        // mail objects to only map-reduce the contacts of
        var docsForContactCounts = [];

        fetch.on('message', function(msg) {
          //winston.doInfo ('imap header', {msg : msg})
          
          var mailObject = {
            'userId' : userId,
            'mailboxId' : mailboxId,
          }

          msg.on('headers', function(hdrs) {
            mailUtils.normalizeAddressArrays (hdrs);
            mailObject['messageId'] = hdrs['message-id'];
            mailObject['sender'] = mailUtils.getSender (hdrs);
            mailObject['recipients'] = mailUtils.getAllRecipients (hdrs);
          });

          msg.on('end', function() {

            mailObject['uid'] = msg.uid;
            mailObject['seqNo'] = msg.seqno;
            mailObject['size'] = msg.size;

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
              if (mailObject.gmDate.getTime() >= argDict.minDateToProcess.getTime()) {
                docsToSave.push (mailObject);
              }

              docsForContactCounts.push (mailObject);
            }

          });

        });


        fetch.on ('end', function () {
          winston.doInfo ('FETCH END', {minUid : minUid, maxUid : maxUid});

          if (argDict.isOnboarding) {
            imapRetrieve.mapReduceContactsInMemory (docsToSave, function (err) {


            });
          }

        });

        fetch.on ('error', function (err) {
          winston.doError ('FETCH ERROR', {msg : err.message, stack : err.stack});
        });

      }
    },
    function(err) {
      if (err) {
        callback (err);
      }
    });
  }
}

exports.saveDocsToDB = function (minUid, maxUid, ) {
  var result = {minUid : minUid, maxUid : maxUid};

  if (docsToSave.length === 0) {
    imapRetrieve.updateOnboardingStateModelWithHeaderBatch (onboardingStateId, result);
    callback (null, result);
    return;
  }

  MailModel.collection.insert (docsToSave, function (err) {
    
    if (err && err.code === 11000){
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

exports.updateOnboardingStateModelWithHeaderBatch = function (onboardingStateId, result){
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

  winston.doInfo ('getUpdates')
  var msgIds = []

  var uidRange = minUid + ':*'

  try {

    imapConn.fetch(uidRange,
      {size : false},
      { headers: false,
        cb: function(fetch) {

          fetch.on('message', function(msg) {
           
            msg.on('end', function() {
              msgIds.push  (msg.uid)
            });   

          });

          fetch.on ('error', function (err) {
            winston.doError ('Imap fetch error', {message : err.message, stack : err.stack});
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
  winston.doInfo ('fetchBoxesToStayAlive fetch', {userId : userId})

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

            fetch.on ('error', function (err) {
              winston.doError ('Imap fetch error', {err : err});
            });

          })
        }
      }, function(err) {

        if (err) {
          getAllMessagesCallback (err)
        }
        else {
          winston.doInfo ('all done fetching msg bodies')
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
