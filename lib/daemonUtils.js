//TODO: fix imports
var constants = require ('../constants'),
    imapConnect = require ('./imapConnect'),
    imapRetrieve = require ('./imapRetrieve'),
    fs = require ('fs'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    conf = require (constants.SERVER_COMMON + '/conf'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    async = require ('async'),
    xoauth2 = require("xoauth2"),
    daemonUtils = require ('./daemonUtils'),
    xoauth2gen;


var MailBox = mongoose.model ('MailBox');
var MailModel = mongoose.model ('Mail');
var UserOnboardingStateModel = mongoose.model ('UserOnboardingState');
var ResumeDownloadStateModel = mongoose.model ('ResumeDownloadState');

var daemonUtils = this;

exports.getXOauthParams = function (userInfo) {
  var params = {
    user: userInfo.email,
    clientId: conf.google.appId,
    clientSecret: conf.google.appSecret,
    refreshToken: userInfo.refreshToken      
  }

  return params;
}

exports.updateStateAndCallback = function (functionName, argDict, callback) {
  if (argDict.isOnboarding) {
    daemonUtils.updateStateOnboarding (argDict.onboardingStateId, functionName, function () {
      daemonUtils.setArgDictRecoveryState (argDict, functionName);
      callback (null, argDict);
    });
  }
  else if (argDict.isResumeDownloading) {
    daemonUtils.updateStateResume (argDict.resumeDownloadingId, functionName, function () {
      daemonUtils.setArgDictRecoveryState (argDict, functionName);
      callback (null, argDict);
    });
  }
  else {
    callback (null, argDict);
  }
}

// resolve the recovery mode flag once we finish the function that the recovery mode started at
exports.setArgDictRecoveryState = function (argDict, functionName) {
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint == functionName) {
    argDict.recoveryMode = false;
  }
}


exports.updateStateOnboarding = function (stateId, newState, cb) {
  UserOnboardingStateModel.update ({_id : stateId}, {$set : {lastCompleted : newState}}, 
    function (err, numAffected) {
      if (err) {
        winston.doError ('Error updating user state with id ' + stateId, err);
      }
      else if (numAffected === 0) {
        winston.error ('Zero records affected when updating user state with id ' + stateId);
      }

      cb();
    });
}

exports.updateStateResume = function (stateId, newState, cb) {
  ResumeDownloadStateModel.update ({_id : stateId}, {$set : {lastCompleted : newState}}, 
    function (err, numAffected) {
      if (err) {
        winston.doError ('Error updating user state with id ' + stateId, err);
      }
      else if (numAffected === 0) {
        winston.error ('Zero records affected when updating user state with id ' + stateId);
      }

      cb();
    });
}

exports.updateErrorState = function (stateId, errorMsg) {
  UserOnboardingStateModel.update ({_id : stateId}, {$set : {errorMsg : errorMsg, hasError : true}}, 
    function (err, numAffected) {
      if (err) {
        winston.doError ('Error updating user state with id ' + stateId, err);
      }
      else if (numAffected === 0) {
        winston.error ('Zero records affected when updating user state with id ' + stateId);
      }
    })
}

exports.updateMailModel = function (uids, userId, setExpression, callback) {

  if (!uids || (uids && uids.length === 0)) { return callback (); }

  var resultsAsInt = uids.map (function (elem) { return parseInt(elem); })

  MailModel.update ({userId : userId, 'uid' : {$in : resultsAsInt}}, 
    {$set : setExpression}, 
    {multi : true})
    .exec(callback);

}

exports.retrieveBatchRecurse = function (query, argDict, maxUid, isAttachment, callback) {

  winston.doInfo ('retrieve batch recurse', {minUid : argDict.minUid, maxUid: argDict.maxUid});

  var myConnection = argDict.myConnection;
  var userId = argDict.userId;

  console.log ('maxUid', maxUid);

  // query database for messages that are attachments
  MailModel.find (query)
    .where('uid').lte(maxUid)
    .where('uid').gte(argDict.minUid)
    .select('uid')
    .sort ('-uid')
    .limit (constants.EMAIL_FETCH_BATCH_SIZE)
    .exec (function (err, messages) {
      if (err) {
        callback (err);
      }
      else {
        
        var msgLength = messages.length;
        
        if (!msgLength) {
          return callback ();
        }

        // last element of array, minus 1 so we don't redo the current last msg
        var newMaxUid = messages[msgLength - 1].uid - 1

        imapRetrieve.getMessagesByUid (myConnection, userId, 
          messages, argDict.isUpdate, function (err, bandwithUsed) {
          
          if (err) {
            //TODO: ... don't fail whole chain???
            callback (err);
          }
          else {
            argDict.totalBandwith += bandwithUsed;

            if (isAttachment) {
              argDict.attachmentBandwith += bandwithUsed;
            }
            else {
              argDict.otherBandwith += bandwithUsed;
            }

            console.log ('totalBandwith', argDict.totalBandwith)
            if (msgLength < constants.EMAIL_FETCH_BATCH_SIZE || newMaxUid < 1) {
              winston.info('retrieveBatchRecurse: Not retrieving emails anymore: no emails left to process with isAttachment: ' + isAttachment);
              callback ();
            }
            else if (argDict.totalBandwith < constants.MAX_BANDWITH_TOTAL) {

              // sub-conditions for isAttachment
              if (isAttachment && argDict.attachmentBandwith > constants.MAX_BANDWITH_ATTACHMENT) {
                winston.info('retrieveBatchRecurse: Not retrieving \
                  emails anymore: attachment bandwith used up: ' + argDict.attachmentBandwith);

                if (!argDict.needsResume) {
                  argDict.needsResume = true
                }

                callback (null);
              }
              else {
                daemonUtils.retrieveBatchRecurse (query, argDict, newMaxUid, isAttachment, callback);
              }

            }
            else {
              if (!argDict.needsResume) {
                argDict.needsResume = true
              }
              winston.info('retrieveBatchRecurse: Not retrieving emails anymore: bandwith used up: ', argDict.totalBandwith);
              callback (null);
            }
          
          }

        });
      }
    });
}


// create or lookup mailbox object for user
exports.createOrLookupMailbox = function createOrLookupMailbox (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail, recoveryMode : argDict.recoveryMode});

  var mailbox = argDict.mailbox;


  // in recovery mode the mailbox obj was already created so we grab it from the DB
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != 'createOrLookupMailbox') {
    MailBox.findOne ({userId : argDict.userId}, function (err, foundMailbox) {
      if (err) {
        winston.doError ('Could not retrieve mailbox for user', {userId : argDict.userId, userEmail : argDict.userEmail});
        callback (err);
      }
      else if (!foundMailbox) {
        winston.error('Could not find mailbox but onboarding state suggests we have it');
        // create a new mailbox since it's unclear what's going on... inconsistent db info
        createNewMailbox();
      }
      else {
        //TODO: figure out what to do in this case
        if (foundMailbox.uidValidity != mailbox.uidvalidity) {
          winston.doError ("Uid validity mismatch", mailbox);
          return callback (err);
        }

        argDict.maxUid = foundMailbox.uidNext-1;
        argDict.mailboxId = foundMailbox._id;
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      }
    })
  }
  else {
    // if we're not in recovery mode, we simply create a new mailbox
    createNewMailbox()
  }

  function createNewMailbox () {

    // new onboarding case
    var box = new MailBox ({
      userId : argDict.userId,
      uidNext: mailbox.uidnext,
      uidValidity : mailbox.uidvalidity,
      name: mailbox.name,
      totalMessages : mailbox.messages.total
    })
  
    box.save (function (err) {
      if (err) {
        callback (err);
      } 
      else {
        argDict.maxUid = box.uidNext -1;
        argDict.mailboxId = box._id;
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      }             
    })
  }

}



// lookup mailbox object for user
exports.lookupMailbox = function lookupMailbox (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  var mailbox = argDict.mailbox;

  //TODO: update maxUid
  MailBox.findOne ({userId : argDict.userId}, function (err, foundMailbox) {
    if (err) {
      winston.doError ('Could not retrieve mailbox for user', {userId : argDict.userId});
      callback (err);
    }
    else if (!foundMailbox) {
      winston.doError ('Could not retrieve mailbox for user', {userId : argDict.userId});
      callback ('Error: no mailbox for user in db');
    }
    else {
      //TODO: figure out what to do in this case
      if (foundMailbox.uidValidity != mailbox.uidvalidity) {
        winston.doError ("Uid validity mismatch", mailbox);
        return callback (err);
      }

      console.log ('mailbox', mailbox);

      winston.doInfo ('lookupMailbox : state', {isUpdate : argDict.isUpdate, isResumeDownloading : argDict.isResumeDownloading});
      winston.doInfo ('lookupMailbox : uid nexts', {mailbox : mailbox.uidnext, foundMailbox : foundMailbox.uidNext});

      // if this is an update (i.e. get future email), but we don't have any difference in uids
      // then that must mean there's nothing to fetch
      if (mailbox.uidnext == foundMailbox.uidNext && argDict.isUpdate) {
        callback ({warning : 'nothing to update, break chain'});
      }
      // fetch the future
      else if (argDict.isUpdate) {
        argDict.minUid = foundMailbox.uidNext;
        argDict.maxUid = mailbox.uidnext - 1 + argDict.numNew;
        argDict.mailboxId = foundMailbox._id;
        callback (null, argDict);
      }
      // fetch the past up to our daily bandwith limit
      else if (argDict.isResumeDownloading) {
        // maxUid already set for isResumeDownloading case
        argDict.minUid = 1;
        argDict.mailboxId = foundMailbox._id;
        callback (null, argDict);
      }

    }
  })

}



exports.retrieveHeaders = function retrieveHeaders (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  // recovery case we must have the headers in the DB already
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != functionName) {
    return callback (null, argDict);
  }

  imapRetrieve.getHeaders(argDict.myConnection, argDict.userId, argDict.mailboxId, 
    argDict.minUid, argDict.maxUid, argDict.onboardingStateId,
    function (err) {
      if (err) {
        console.log ('callback', callback);
        console.log ('error', err);
        callback (err);
      }
      else {
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      }
    });

}


exports.retrieveHeadersInBatch = function retrieveHeadersInBatch (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  // recovery case we must have the headers in the DB already
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != functionName) {
    return callback (null, argDict);
  }

  imapRetrieve.getHeadersInBatches(argDict.myConnection, argDict.userId, argDict.mailboxId, 
    argDict.minUid, argDict.maxUid, argDict.onboardingStateId, argDict.recoveryMode,
    function (err) {
      if (err) {
        callback (err);
      }
      else {
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      }
    });


}

exports.setDeletedMessages = function setDeletedMessages (argDict, callback) {
  imapRetrieve.getUpdates (argDict.myConnection, argDict.minUid, function  (err, results) {
    MailModel.update ({userId : argDict.userId, uid : {$nin : results}}, 
      {$set : {isDeleted : true}}, 
      {multi : true}, 
      function (err, num) {
        if (err) {
          winston.doError ('Error could not update deleted mail messages', err);
        }
        else {
          console.log (num + ' records marked isDeleted=true')
        }
      });
  })
}

exports.mapReduceContacts = function mapReduceContacts (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  var userEmail = argDict.userEmail;

  // recovery case, we must have the headers in the DB already
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != functionName) {
    return callback (null, argDict);
  }

  var query = {userId : argDict.userId};

  if (argDict.minUid) {
    query.uid = { $gt: argDict.minUid }
  }

  var o = {
    scope : {userEmail : userEmail}, 
    out : {reduce: 'sentandcoreceivemrs'}, 
    query : query
  };

  o.map = function () {
    var that = this;

    this.recipients.forEach (function (rec) { 
      var senderEmit = false;
      var key = {email : rec.email, userId : that.userId};
      var value = {sent : 0, corecipient : 0};

      // recipients are people I have sent emails to
      if (that.sender.email == userEmail) {
        value.sent = 1;
      }
      // recipients are people I have been included in emails with
      else {
        value.corecipient = 1;
      }

      emit(key, value);
    })
  }


  
  o.reduce = function (key, values) { 
    var reducedValue = {sent : 0, corecipient : 0}

    for (var idx = 0; idx < values.length; idx++) {
      reducedValue.sent += values[idx].sent;
      reducedValue.corecipient += values[idx].corecipient;
    }

    return reducedValue;
  }

  MailModel.mapReduce(o, function (err, results) {
    if (err) {
      callback (err);
    }
    else {
      daemonUtils.updateStateAndCallback (functionName, argDict, callback);
    }
  })

}


exports.mapReduceReceiveCounts = function mapReduceReceiveCounts (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  var userEmail = argDict.userEmail;

  // recovery case, we must have the headers in the DB already
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != functionName) {
    return callback (null, argDict);
  }

  var query = {userId : argDict.userId};

  if (argDict.minUid) {
    query.uid = { $gt: argDict.minUid }
  }

  var o = {
    scope : {userEmail : userEmail}, 
    out : {reduce: 'receivemrs'}, 
    query : query
  };

  o.map = function () { 
    emit({email : this.sender.email, userId : this.userId}, 1);
  }

  o.reduce = function (key, value) { 
    return Array.sum(value);
  }

  MailModel.mapReduce(o, function (err, results) {
    if (err) {
      callback (err);
    }
    else {
      daemonUtils.updateStateAndCallback (functionName, argDict, callback);
    }
  });

}


exports.markMarketingFromEmails = function markMarketingFromEmails (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  // recovery case, we must have the headers in the DB already
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != functionName) {
    return callback (null, argDict);
  }

  imapRetrieve.getMarketingFromIds (argDict.myConnection, argDict.minUid, argDict.maxUid, function (err, uids) {
    if (err) {
      callback (err);
    }
    else {
      daemonUtils.updateMailModel (uids, argDict.userId, 
        {hasMarketingFrom : true},
        function (err, num) {
          if (err) { 
            callback (err) 
          } else {
            daemonUtils.updateStateAndCallback (functionName, argDict, callback);
          }
        });
    }
  })
}

exports.markMarketingTextEmails = function markMarketingTextEmails (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  // recovery case, we must have the headers in the DB already
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != functionName) {
    return callback (null, argDict);
  }

  imapRetrieve.getMarketingTextIds (argDict.myConnection, argDict.minUid, argDict.maxUid, function (err, uids) {
    if (err) {
      callback (err);
    }
    else {
      daemonUtils.updateMailModel (uids, argDict.userId, 
        {hasMarketingText : true}, 
        function (err, num) {
          if (err) { 
            callback (err);
          } else {
            daemonUtils.updateStateAndCallback (functionName, argDict, callback);
          }
        });
    }
  })
}

exports.createTempDirectoryForEmails  = function createTempDirectoryForEmails (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  // always create temp directory even if starting point doesn't match since this is local to fs
  var dir = constants.TEMP_FILES_DIR + '/' + argDict.userId;

  //check existence
  fs.exists(dir, function (exists) {
    if (exists) {
      daemonUtils.updateStateAndCallback (functionName, argDict, callback);
    }
    else {
      fs.mkdir (dir, function (err) {

        if (err) {
          callback (winston.makeError ('Could not make temp directory for user email', {dir : dir}));
        }
        else {
          daemonUtils.updateStateAndCallback (functionName, argDict, callback);
        }

      })
    }
  })
}


exports.retrieveAttachments = function retrieveAttachments (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  // recovery case, we must have the attachments in the DB already
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != functionName) {
    return callback (null, argDict);
  }

  // get the messageIds with attachments
  imapRetrieve.getIdsOfMessagesWithAttachments (argDict.myConnection, argDict.minUid, argDict.maxUid, function (err, uids) {
    if (err) {
      callback (err);
    }
    else if (!uids) {
      daemonUtils.updateStateAndCallback (functionName, argDict, callback);
    }
    else {
      daemonUtils.updateMailModel (uids, argDict.userId, 
        {hasAttachment : true}, 
        function (err, numAffected) {
          if (err) {
            callback (err);
          }
          else {
            winston.info (numAffected);
            
            var query = {
              hasAttachment : true, 
              userId : argDict.userId, 
              s3Path : {$exists : false}
            }

            var isAttachment = true;

            daemonUtils.retrieveBatchRecurse (query, argDict, argDict.maxUid, isAttachment, function (err) {
              if (err) {
                winston.doError ('Error recursively getting attachments', err);
              }

              daemonUtils.updateStateAndCallback (functionName, argDict, callback);

            });
          }
        });
    }
  });

}

exports.retrieveEmailsNoAttachments = function retrieveEmailsNoAttachments (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  // recovery case, we must have the attachments in the DB already
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != 'retrieveEmailsNoAttachments') {
    return callback (null, argDict);
  }

  var totalBandwith = argDict.totalBandwith;

  if (totalBandwith < constants.MAX_BANDWITH_TOTAL) {

    // we don't download emails with marketing text
    var query = {
      s3Path : {$exists : false},
      hasAttachment : {$ne : true},
      userId : argDict.userId,
      hasMarketingFrom : {$ne : true},
      hasMarketingText : {$ne : true}
    }

    var isAttachment = false;

    daemonUtils.retrieveBatchRecurse (query, argDict, argDict.maxUid, isAttachment, function (err) {
      //TODO: clean this up - what would the err be? should we fail the chain?
      if (err) {
        winston.doError ('Error recursively getting attachments', err);
      }

      daemonUtils.updateStateAndCallback (functionName, argDict, callback);

    });

  }
  else {
    winston.info('retrieveEmailsNoAttachments: Not retrieving emails anymore \
      because bandwith limit exceeded', totalBandwith);

    if (!argDict.needsResume) {
      argDict.needsResume = true
    }

    daemonUtils.updateStateAndCallback (functionName, argDict, callback);
  }

}


exports.markStoppingPoint = function markStoppingPoint (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  if (argDict.needsResume) {
    var resume = new ResumeDownloadStateModel({
      userId: argDict.userId,
      mailBoxId: argDict.mailboxId,
      resumeAt : Date.now() + constants.RESUME_DOWNLOAD_AFTER,
      maxUid : argDict.maxUid
    });

    resume.save (function (err) {
      if (err) {
        callback (err)
      }
      else {
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      }
    })
  }
  else {
    daemonUtils.updateStateAndCallback (functionName, argDict, callback);
  }
}

exports.updateMailbox = function updateMailbox (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  MailBox.update ({_id : argDict.mailboxId}, 
    {$set : {uidNext : argDict.mailbox.uidnext, lastUpdate : Date.now()}}, 
    function (err, numAffected) {
      winston.info (numAffected + " mailboxes updated uid next");
      callback (null, argDict);
    });
}