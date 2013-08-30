var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants'),
    conf = require (serverCommon + '/conf'),
    _ = require ('underscore'),
    mailUtils = require (serverCommon + '/lib/mailUtils'),
    mongoUtils = require(serverCommon + '/lib/mongoUtils'),
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose,
    mikeyMailConstants = require ('../constants'),
    daemonUtils = require ('./daemonUtils'),
    ReceiveMRModel = require(serverCommon + '/schema/contact').ReceiveMRModel,
    SentAndCoReceiveMRModel = require(serverCommon + '/schema/contact').SentAndCoReceiveMRModel,
    MailModel = require (serverCommon + '/schema/mail').MailModel,
    UserOnboardingStateModel = require(serverCommon + '/schema/onboard').UserOnboardingStateModel,
    ResumeDownloadStateModel = require(serverCommon + '/schema/onboard').ResumeDownloadStateModel,
    async = require ('async'),
    Imap = require ('imap'),
    inspect = require('util').inspect,
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    uploadUtils = require ('./uploadUtils');
    
var imapRetrieve = this;

exports.imapSearch = function (imapConn, criteria, callback) {
  imapConn.search(criteria, function(err, results) {
    callback (err, results);
  });
}

// version that assumes onboarding
exports.getHeadersInBatches = function (argDict, callback) {

  var minUid = argDict.minUid;
  var maxUid = argDict.maxUid;

  var Model = UserOnboardingStateModel;
  var stateId = argDict.onboardingStateId;

  if (argDict.isResumeDownloading) {
    Model = ResumeDownloadStateModel;
    stateId = argDict.resumeDownloadingId;
  }

  var inRecoveryMode = argDict.recoveryMode;

  var numIntervals = Math.ceil(maxUid/constants.HEADER_BATCH_SIZE);
  winston.doInfo('getHeadersInBatches with ' + numIntervals + ' intervals');
  var asyncFunctionArguments = [];

  imapRetrieve.getHeaderSkipIntervals (Model, stateId, inRecoveryMode, function (err, intervalsToSkip) {

    if (err) {
      callback(winston.makeMongoError (err, {stateId : stateId}));
      return;
    }

    // set up the intervals
    for (var i = 0; i < numIntervals; i++) {
      var minUidBatch = minUid + i*constants.HEADER_BATCH_SIZE;
      var maxUidBatch = Math.min((i+1)*constants.HEADER_BATCH_SIZE, maxUid);

      var pushToAsync = true;

      intervalsToSkip.forEach (function (interval) {
        if (minUidBatch == interval.minUid && maxUidBatch == interval.maxUid) {
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

    // all done
    async.forEachSeries (asyncFunctionArguments, function (args, asyncCb) {
      imapRetrieve.getHeaders (argDict, args.minUidBatch, args.maxUidBatch, null, asyncCb);
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


exports.getHeadersForResumePremium = function (argDict, callback) {
  var minUid = 1;
  var maxUid = argDict.maxUid;
  var inRecoveryMode = argDict.recoveryMode;
  var numIntervals = Math.ceil(maxUid/constants.HEADER_BATCH_SIZE);

  var asyncFunctionArguments = [];

  // set up the intervals
  for (var i = 0; i < numIntervals; i++) {
    var minUidBatch = minUid + i*constants.HEADER_BATCH_SIZE;
    var maxUidBatch = Math.min((i+1)*constants.HEADER_BATCH_SIZE, maxUid);
    var pushToAsync = true;

    if (pushToAsync) {
      asyncFunctionArguments.push ({
        'minUidBatch' : minUidBatch,
        'maxUidBatch' : maxUidBatch
      });
    }
  }

  // all done
  async.forEachSeries (asyncFunctionArguments, function (args, asyncCb) {
    imapRetrieve.getHeaders (argDict, args.minUidBatch, args.maxUidBatch, null, asyncCb);
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
}


// version for resumes
exports.getMoreHeadersForResume = function (argDict, callback) {

  var minUid = argDict.minUid;
  var maxUid = argDict.maxUid;
  var resumeDownloadingId = argDict.resumeDownloadingId;
  var inRecoveryMode = argDict.recoveryMode;

  // we need to get all headers basically
  if (argDict.isPremium) {
    imapRetrieve.getHeadersInBatches (argDict, callback);
  } else {

    // get id's of mail between first parameter and second parameter
    var after = Math.floor(argDict.minDate.getTime()/1000);
    var before = Math.floor (argDict.maxDate.getTime()/1000);

    winston.doInfo ('resume get more headers in range:', {after : after, before : before});

    imapRetrieve.getIdsOfMessagesInDateRange (argDict.myConnection, after, before, 
      function (err, uids) {
        if (err) {
          callback (err);
        } else if (uids.length === 0) {
          winston.doWarn ('getMoreHeadersForResume: 0 uid length, no extra headers needed');
          callback(null, argDict);
        } else {
          // if the array is too long split it into multiple arrays
          var uidLen = uids.length;
          var numBatches = 1;

          // TODO: test for corner cases of 
          if (uidLen > mikeyMailConstants.RESUME_BATCH_SIZE) {
            // split into batches
            numBatches = Math.floor(uidLen/mikeyMailConstants.RESUME_BATCH_SIZE) + 1;
          }

          var asyncFunctionArguments=[];

          for (var i=0; i<numBatches; i++) {
            if (i == numBatches - 1) {
              asyncFunctionArguments.push ({'uids' : uids.slice (i * mikeyMailConstants.RESUME_BATCH_SIZE, uidLen)});
            } else {
              asyncFunctionArguments.push ({'uids' : uids.slice (i * mikeyMailConstants.RESUME_BATCH_SIZE, (i+1) * mikeyMailConstants.RESUME_BATCH_SIZE)});
            }
          }

          async.forEachSeries (asyncFunctionArguments, function (args, asyncCb) {
            imapRetrieve.getHeaders (argDict, null, null, args.uids, asyncCb);
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
        }
      });
  }
}



exports.getHeaderSkipIntervals = function (Model, stateId, inRecoveryMode, callback) {
  var intervalsToSkip = [];

  if (!inRecoveryMode) {
    callback (null, intervalsToSkip);
  }
  else {
    Model.findById (stateId, function (err, state) {
      if (err) {
        callback(winston.makeMongoError (err, {stateId : stateId}));
      }
      else if (!state) {
        callback(winston.makeError ('could not find onboarding state', {stateId : stateId}));        
      }
      else {
        intervalsToSkip = state.headerBatchesComplete;
        callback (null, intervalsToSkip);
      }
    });
  }
}

// if uidArray is specified we ignore minUid, maxUid and just retrieve by that array
exports.getHeaders = function (argDict, minUid, maxUid, uidArray, callback) {

  // unpack variables
  var imapConn = argDict.myConnection;
  var userId = argDict.userId;
  var mailboxId = argDict.mailboxId;
  var onboardingStateId = argDict.onboardingStateId;
  var isOnboarding = argDict.isOnboarding;
  var isResumeDownloading = argDict.isResumeDownloading;
  var resumeDownloadingId = argDict.resumeDownloadingId;
  var folderNames = argDict.mailbox.folderNames;
  var isPremium = argDict.isPremium;
  var uidQuery;


  if (uidArray) {
    winston.doInfo ('getHeaders by array', {uidArray : uidArray});

    if (!uidArray.length) {
      return callback (winston.makeError ('getHeaders validation error: uidArray invalid',
        {userId : userId, stateId : onboardingStateId, uidArray : uidArray}));
    }
  
    uidQuery = uidArray;
    argDict.uidArray = uidArray;
  } else {
    winston.doInfo ('getHeaders in range', {minUid : minUid, maxUid:maxUid});    

    if (!minUid || !maxUid || (maxUid != '*' && minUid > maxUid)) {
      return callback (winston.makeError ('getHeaders validation error: minUid, maxUid invalid',
        {userId : userId, stateId : onboardingStateId, minUid : minUid, maxUid : maxUid}));
    }

    uidQuery = minUid + ':' + maxUid;
  }

  var currentLength = 0;


  var fetch = imapConn.fetch(uidQuery, {
    bodies: 'HEADER.FIELDS (MESSAGE-ID FROM TO CC BCC DATE X-IS-MIKEY)',
    size: true
  });

  // mail objects to be written to the databas
  var docsToSave = [];

  // mail objects to only map-reduce the contacts of
  var docsForContactCounts = [];

  fetch.on ('message', function (msg, uid) {

    var mailObject = {
      'userId' : userId,
      'mailboxId' : mailboxId,
    }
    var prefix = '(#' + uid + ') ';

    msg.on('body', function (stream, info) {
      var buffer = '', count = 0;

      stream.on('data', function(chunk) {
        count += chunk.length;
        buffer += chunk.toString('utf8'); //TODO: binary?
      });

      stream.once('end', function() {
        if (info.which !== 'TEXT') {
          var hdrs = Imap.parseHeader (buffer);

          mailObject['messageId'] = hdrs['message-id'];
          if (hdrs['x-is-mikey'] && hdrs['x-is-mikey'].length) {
            mailObject['isMikeyLike'] = true
          }

          mailObject['sender'] = mailUtils.getSender (hdrs);
          mailObject['recipients'] = mailUtils.getAllRecipients (hdrs);
        }
      });
    });

    msg.once('attributes', function(attrs) {

      mailObject['uid'] = attrs.uid;
      mailObject['seqNo'] = attrs.seqno;
      mailObject['size'] = attrs.size;

      if(attrs['date']) {
        mailObject['gmDate'] = new Date( Date.parse( attrs['date'] ) );
      }

      if (attrs['x-gm-thrid']) {
        mailObject.gmThreadId = attrs['x-gm-thrid'];
      }

      if (attrs['x-gm-msgid']) {
        mailObject.gmMsgId = attrs['x-gm-msgid'];
      }

      if (attrs['x-gm-labels']) {
        mailObject.gmLabels = [];

        attrs['x-gm-labels'].forEach (function (label) {
          mailObject.gmLabels.push (label);
        })

      }
    });

    msg.once('end', function() {
      if (!imapRetrieve.checkLabelIsInvalid (mailObject, folderNames)) {
        if (isPremium || mailObject.gmDate.getTime() >= argDict.minDate.getTime()) {
          docsToSave.push (mailObject);
        }

        currentLength += 1;

        // only update this during onboarding or new mail updates
        if (!isResumeDownloading) {
          docsForContactCounts.push (mailObject);
        }

        // update min overall date (only during onboarding)
        if (isOnboarding && mailObject.gmDate && mailObject.gmDate.getTime() < argDict.earliestEmailDate.getTime()) {
          winston.doInfo ('update min date for user to ', {date : mailObject.gmDate});
          argDict.earliestEmailDate = mailObject.gmDate;
          daemonUtils.markMinMailDateForUser (argDict.userId, mailObject.gmDate);
        }

        if (!mailObject.gmDate) {
          winston.doWarn ('mailObject does not have a gmDate', {mailObject : mailObject});
        }

      }
    });

  });

  fetch.on ('end', function () {
    winston.doInfo ('FETCH END', {minUid : minUid, maxUid : maxUid});

    var result = {minUid : minUid, maxUid : maxUid, numMails : currentLength};

    // we need to both save any docs worth saving and ensure that the
    // contact counts are updated prior
    async.parallel([
      function(asyncCb){
        if (!isResumeDownloading) {
          var mrResults = imapRetrieve.mapReduceContactsInMemory (argDict.userId, argDict.userEmail, docsForContactCounts);
          imapRetrieve.incrementMapReduceValuesInDB (mrResults, argDict.userId, argDict.userEmail, asyncCb);
        } else {
          asyncCb();
        }
      },
      // save the docsToSave
      function(asyncCb){

        if (docsToSave.length == 0) {
          asyncCb();
        } else {

          MailModel.collection.insert (docsToSave, function (err) {
            if (err && err.code == 11000){
              asyncCb ();
            } else if (err) {
              asyncCb (winston.makeError ('Error from bulk insert', {err : err}));
            } else {
              asyncCb ();
            }
          });
        }
      }
    ],
    function(err, results){
      if (err) {
        callback (err);
      } else {
        if (isOnboarding) {
          imapRetrieve.updateOnboardingStateModelWithHeaderBatch (onboardingStateId, result, function (err) {
            if (err) {
              callback (err);
            } else {
              callback();
            }
          });
        } else if (isPremium && isResumeDownloading) {
          imapRetrieve.updateResumeDownloadModelWithHeaderBatch (resumeDownloadingId, result, function (err) {
            if (err) {
              callback (err);
            } else {
              callback();
            }
          });
        } else {
          callback();
        }            
      }
    });
  });

  fetch.on ('error', function (err) {
    winston.doError ('FETCH ERROR', {msg : err.message, stack : err.stack});
  });

}


exports.mapReduceContactsInMemory = function (userId, userEmail, docsForContactCounts) {
  var sentDict = {};
  var coReceiveDict = {};
  var receiveDict = {};

  docsForContactCounts.forEach (function (doc) {
    doc.recipients.forEach (function (recipient) {
      var key = recipient.email;

      // ignore invalid keys - easy check is too many @ symbols
      // TODO: put in actual email address validation
      var numAddresses = key.split("@").length - 1
      if (numAddresses !== 1) {
        winston.doWarn ('ignoring invalid recipient email address', {address : key});
        return;
      }

      if (doc.sender.email == userEmail) {
        imapRetrieve.incrementDictForKey (key, sentDict);
      } else {
        imapRetrieve.incrementDictForKey (key, coReceiveDict);
      }
    });

    var senderKey = doc.sender.email;

    // ignore invalid keys - easy check is too many @ symbols
    // TODO: put in actual email address validation
    var numAddresses = senderKey.split("@").length - 1
    if (numAddresses !== 1) {
      winston.doWarn ('ignoring invalid sender email address', {address : senderKey});
      return;
    } else {
      imapRetrieve.incrementDictForKey (senderKey, receiveDict);
    }

  });

  var results = {
    sentDict : sentDict,
    coReceiveDict : coReceiveDict,
    receiveDict : receiveDict
  }

  return results;
}


exports.incrementDictForKey = function (key, dict) {
  if (key in dict) {
    dict[key] += 1;
  } else {
    dict[key] = 1;
  }
}


exports.incrementMapReduceValuesInDB = function (mrResults, userId, userEmail, callback) {
  var sentDictKeys = Object.keys(mrResults.sentDict);
  var coReceiveDictKeys = Object.keys(mrResults.coReceiveDict);
  var receiveDictKeys = Object.keys(mrResults.receiveDict);

  async.parallel ([
    function (pCb) {
      async.each(sentDictKeys, function (key, eachCb) {
        var keyObj = {_id: { email: key, userId: userId }};
        var increment =  mrResults.sentDict[key];

        SentAndCoReceiveMRModel.collection.update (keyObj, {$inc : {"value.sent" : increment}}, {upsert : true}, function (err, num) {
          if (err) {
            eachCb (winston.makeMongoError (err));
          } else {
            eachCb ();
          }
        });
      }, pCb);
    },
    function (pCb) {
      async.each(coReceiveDictKeys, function (key, eachCb) {
        var keyObj = {_id: { email: key, userId: userId }};
        var increment = mrResults.coReceiveDict[key];

        SentAndCoReceiveMRModel.collection.update (keyObj, {$inc : {"value.corecipient" : increment}}, {upsert : true}, function (err, num) {
          if (err) {
            eachCb(winston.makeMongoError (err));
          } else {
            eachCb();
          }
        });
      }, pCb);
    },
    function (pCb) {
      async.each(receiveDictKeys, function (key, eachCb) {
        var keyObj = {_id: { email: key, userId: userId }};
        var increment =  mrResults.receiveDict[key];

        ReceiveMRModel.collection.update (keyObj, {$inc : {"value" : increment}}, {upsert : true}, function (err, num) {
          if (err) {
            eachCb(winston.makeMongoError (err));
          } else {
            eachCb();
          }
        });

      }, pCb);
    },
  ], callback);

}

exports.checkLabelIsInvalid = function (mailObject, folderNames) {
  var isInvalid = false;

  var skipLabels = [];

  if (!folderNames) {
    winston.doError ('Folder names have not been extracted!');
    return isInvalid;
  }

  if (folderNames['\\Trash']) {
    var name = folderNames['\\Trash'].toLowerCase();
    skipLabels.push (name);
    skipLabels.push (name.substring (0, name.length-1));
  }
  
  if (folderNames['\\Drafts']) {
    var name = folderNames['\\Drafts'].toLowerCase();
    skipLabels.push (name);
    skipLabels.push (name.substring (0, name.length-1));
  }

  if (folderNames ['\\Junk']) {
    var name = folderNames['\\Junk'].toLowerCase();
    skipLabels.push (name);
    skipLabels.push (name.substring (0, name.length-1));  
  }

  // sanity check
  if (skipLabels.length == 0) {
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
          winston.doInfo ('invalid label', {label :label});
        }
      }

    });
  }

  return isInvalid;
}

exports.updateOnboardingStateModelWithHeaderBatch = function (onboardingStateId, result, callback) {
  UserOnboardingStateModel.update ({_id : onboardingStateId},
    {$push : {headerBatchesComplete : result}},
    function (err, num) {
      if (err) {
        callback (winston.makeMongoError (err));
      }
      else if (num === 0) {
        callback (winston.makeError ('zero records affected updating onboarding state', err));
      }
      else {
        winston.doInfo ('updated onboarding state with completed batch', {minUid : result.minUid, maxUid : result.maxUid, numMails : result.numMails});
        callback();
      }
    });
}

exports.updateResumeDownloadModelWithHeaderBatch = function (resumeDownloadingId, result, callback) {
  ResumeDownloadStateModel.update ({_id : resumeDownloadingId},
    {$push : {headerBatchesComplete : result}},
    function (err, num) {
      if (err) {
        callback (winston.makeMongoError (err));
      }
      else if (num === 0) {
        callback (winston.makeError ('zero records affected updating resume download state', err));
      }
      else {
        winston.doInfo ('updated resume download state with completed batch', {minUid : result.minUid, maxUid : result.maxUid, numMails : result.numMails});
        callback();
      }
    });
}


exports.getIdsOfMessagesWithAttachments = function (imapConn, minUid, maxUid, uidArray, callback) {
  var uidQuery = imapRetrieve.getUidQuery (minUid, maxUid, uidArray);

  if (!uidQuery) {
    return callback (null, []);
  }

  imapConn.search([ ['X-GM-RAW', 'has:attachment'], ['UID', uidQuery]], function(err, results) {
    callback (err, results)
  });

}

exports.getUidQuery = function (minUid, maxUid, uidArray) {
  var uidQuery = '1:*';
  if (uidArray) {
    if (uidArray.length) {
      var min = Math.min.apply(Math, uidArray);
      // always want to go high for consistency during "recovery" modes
      uidQuery = imapRetrieve.getUidRangeString(min, '*');
    }
  } else {
    uidQuery = imapRetrieve.getUidRangeString(minUid, maxUid);
  }

  return uidQuery;
}

exports.getIdsOfMessagesInDateRange = function (imapConn, minDate, maxDate, callback) {
  // this is to ensure we don't have to worry about
  // less/greater than, less/greater than or equal to problems
  maxDate = maxDate + 1;
  minDate = minDate - 1;

  var searchString = 'before:' + maxDate + ' after:' + minDate;
  winston.doInfo ('new search string', {searchString : searchString});

  imapConn.search([ ['X-GM-RAW', searchString]], function(err, results) {
    callback (err, results)
  });
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

exports.getMarketingTextIds = function (imapConn, minUid, maxUid, uidArray, callback) {
  var uidQuery = imapRetrieve.getUidQuery (minUid, maxUid, uidArray);

  if (!uidQuery) {
    return callback (null, []);
  }

  imapConn.search([ ['X-GM-RAW', constants.MARKETING_TEXT], ['UID', uidQuery]], function(err, results) {
    callback (err, results)
  });

}


exports.getMarketingFromIds = function (imapConn, minUid, maxUid, uidArray, callback) {
  var uidQuery = imapRetrieve.getUidQuery (minUid, maxUid, uidArray);

  if (!uidQuery) {
    return callback (null, []);
  }

  imapConn.search([ ['X-GM-RAW', constants.MARKETING_FROM], ['UID', uidQuery]], function(err, results) {
    callback (err, results)
  });

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

  var msgsReceived = [];
  var msgsUploaded = [];
  var bandwithUsed = 0;

  var fetch = imapConn.fetch(uidArray, { bodies: [''], size: true });
  var cbCalled = false;
  var fetchEnd = false;
  var count = 0;


  // log every 20 seconds
  var intervalId = setInterval (function () {
    winston.doInfo ('fetchMsgBodies status', 
      {fetchEnd : fetchEnd, cbCalled : cbCalled, msgsReceived : msgsReceived, msgsUploaded : msgsUploaded, userId : userId});
    count+=1;

    // fetch isn't complete... for two minutes something is wrong
    if (count > 10) {
      var diff = _.difference(msgsReceived,msgsUploaded);

      winston.doWarn ('fetchMsgBodies status', 
        {fetchEnd : fetchEnd, cbCalled : cbCalled, diff : diff, userId : userId});
    }

  }, 20000);



  fetch.on ('message', function (msg, uid) {
    var buffer = '', count = 0;

    msg.on('body', function (stream, info) {
      stream.on('data', function(chunk) {
        count += chunk.length;
        buffer += chunk.toString('binary');
      });
    });

    msg.on('attributes', function(attrs) {
      msg.uid = attrs.uid;
      msg.size = attrs.size;
    });

    msg.on('end', function() {
      bandwithUsed += msg.size;
    
      var headers = {
        'Content-Type': 'text/plain',
        'x-amz-server-side-encryption' : 'AES256'
      }

      var cloudPath = cloudDirectory + '/' + msg.uid + '-body.txt';
      msgsReceived.push (msg.uid);

      if (fetchEnd) {
        // THIS IS BAD IF IT HAPPENS
        winston.doError ('Fetch end called before msg end', {userId : userId});
      }

      // upload mails in batch to the cloud, callback once we have received EVERYTHING
      uploadUtils.uploadBufferToCloud (buffer, cloudPath, headers, userId, msg.uid, isUpdate, 
        function (err) {
          if (err) {
            if (!cbCalled) {
              getAllMessagesCallback (err);
              clearInterval(intervalId);
              cbCalled = true;
            } else {
              winston.handleError (err);
            }
          } else {
            msgsUploaded.push (msg.uid);

            // check if everything is done
            if (imapRetrieve.everythingFetchedAndUploaded (msgsUploaded, msgsReceived, fetchEnd) && !cbCalled) {
              getAllMessagesCallback (null, bandwithUsed);
              clearInterval(intervalId);
              cbCalled = true;          
            }
          }
        });

    });
  });

  fetch.on ('end', function () {
    winston.doInfo ('fetch mail bodies end event', {userId : userId});
    fetchEnd = true;
    // check if everything is done
    if (imapRetrieve.everythingFetchedAndUploaded (msgsUploaded, msgsReceived, fetchEnd) && !cbCalled) {
      getAllMessagesCallback (null, bandwithUsed);
      clearInterval(intervalId);
      cbCalled = true;          
    }
  });

  fetch.on ('error', function (err) {
    if (!cbCalled) {
      getAllMessagesCallback (winston.makeError ('error fetching mail bodies', {err : err}));
      clearInterval(intervalId);
      cbCalled = true;
    } else {
      winston.doError ('error fetching mail bodies (but cb already called)', {err : err});
    }
  });





}

exports.everythingFetchedAndUploaded = function (msgsUploaded, msgsReceived, fetchEnd) {
  return msgsUploaded.length == msgsReceived.length && fetchEnd;
}

// local helper functions
exports.getUidRangeString = function (minUid, maxUid) {
  return minUid + ':'  + maxUid;
}
