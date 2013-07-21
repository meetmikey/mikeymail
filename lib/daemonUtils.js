var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants'),
    imapRetrieve = require ('./imapRetrieve'),
    sesUtils = require (serverCommon + '/lib/sesUtils'),
    fs = require ('fs'),
    _ = require ('underscore'),
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose,
    conf = require (serverCommon + '/conf'),
    async = require ('async'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston;

var MailBox = mongoose.model ('MailBox');
var MailModel = mongoose.model ('Mail');
var UserModel = mongoose.model ('User');
var UserOnboardingStateModel = mongoose.model ('UserOnboardingState');
var ResumeDownloadStateModel = mongoose.model ('ResumeDownloadState');

var daemonUtils = this;

exports.getUserInfoFromDB = function (userId, callback) {
  UserModel.findById (userId, function (err, foundUser) {
    if (err || !foundUser) {
      callback (winston.makeError ('could not getUserInfoFromDB', {err : err, user : foundUser}));
    }
    else {
      callback (null, foundUser);
    }
  });
}

exports.updateUserTokenValidity = function (userId, callback) {
  winston.doInfo ('updateUserTokenValidity', {userId : userId});
  UserModel.update ({_id : userId},
    {$set : {invalidToken : true}},
    function (err) {
      if (err) {
        callback (winston.makeMongoError (err));
      } else {
        callback ();
      }
    });
}

exports.setUserAllMailError = function (user, errorType, callback) {
  user.allMailError = true;

  user.save (function (err) {
    if (err) {
      callback (winston.makeMongoError (err));
    } else {
      // send an email to ourselves so we know this user's account can't be processed
      sesUtils.sendInternalNotificationEmail ('ALL MAIL doesn\'t exist for user ' + user.email + ' ErrorType: ' + errorType, 'ALLMAIL missing error', 
        function (err) {
          callback (err);
        });
    }
  });
}

exports.unSetUserAllMailError = function (user){
  user.allMailError = false;

  user.save (function (err) {
    if (err) {
      winston.doMongoError (err);
    }
  });
}

exports.updateMinProccessedDateForUser = function (userId, minProcessedDate, callback) {
  UserModel.update ({_id : userId, minProcessedDate : {$gt : minProcessedDate}},
    {$set : {minProcessedDate : minProcessedDate}},
    function (err) {
      if (err) {
        callback (winston.makeMongoError (err));
      } else {
        callback ();
      }
    });
}


exports.accountLimitReached = function (argDict) {
  if (argDict.isPremium) {
    return false;
  } else if (!(argDict.isOnboarding || argDict.isResumeDownloading)) {
    return false; // disregard for mail listen updates
  } else {
    return (argDict.minProcessedDate.getTime() < argDict.minDateAccount.getTime());
  }
}

exports.isLimitedAccount = function (argDict) {
  if (argDict.isPremium) {
    return false;
  } else if (!(argDict.isOnboarding || argDict.isResumeDownloading)) {
    return false; // disregard for mail listen updates
  } else {
    return true;
  }
}

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
  UserOnboardingStateModel.update ({_id : stateId},
    {$set : {lastCompleted : newState}},
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
  ResumeDownloadStateModel.update ({_id : stateId},
    {$set : {lastCompleted : newState}},
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
  UserOnboardingStateModel.update ({_id : stateId},
    {$set : {errorMsg : errorMsg, hasError : true}},
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

exports.updateBandwithUsed = function (Model, modelId, bandwith) {
  if (!bandwith || bandwith <= 0) { return; }

  Model.update ({_id : modelId}, {$inc : {'bandwith' : bandwith}}, function (err, num) {
    if (err) {
      winston.doMongoError (err);
    }
    else if (num === 0) {
      winston.doError ('No records affected when updating bandwith', {modelId : modelId, modelName : Model.modelName});
    }
    else {
      winston.doInfo ('Bandwith updated in database for:', {modelId : modelId, modelName : Model.modelName});
    }
  });
}

exports.retrieveBatchRecurse = function (query, argDict, maxDateBatch, callback) {

  var logInfo = {
    userEmail : argDict.userEmail,
    userId : argDict.userId,
    minDateAccount : argDict.minDateAccount, 
    maxDate: maxDateBatch, 
    minUid : argDict.minUid, 
    minDate : argDict.minDate
  };

  winston.doInfo ('retrieve batch recurse', logInfo);

  var myConnection = argDict.myConnection;
  var userId = argDict.userId;
  var mongoQuery = MailModel.find(query);

  // if we have a premium account there's no need to filter
  // the bottom end of the spectrum except for efficiency gains
  // during the updates for "new stuff"
  if (daemonUtils.isLimitedAccount (argDict) || argDict.isUpdate) {
    mongoQuery.where ('gmDate').gte (argDict.minDate.getTime());
  }

  if (maxDateBatch) {
    mongoQuery.where('gmDate').lte(maxDateBatch.getTime());
  }

  mongoQuery.select ('uid gmDate hasMarketingText hasMarketingFrom hasAttachment');
  mongoQuery.sort ('-gmDate');

  mongoQuery.limit (constants.EMAIL_FETCH_BATCH_SIZE);

  // query database for messages that are attachments  
  mongoQuery.exec (function (err, messages) {
    if (err) {
      callback (winston.makeMongoError(err));
    }
    else {
      var msgLength = messages.length;

      if (!msgLength) {
        return callback ();
      }

      var messagesToDownload = messages;

      // last element of array, minus 1 so we don't redo the current last msg
      var newMaxDate = messages[msgLength - 1].gmDate;
      winston.doInfo ('newMaxDate', {date : newMaxDate});

      // get rid of things with a date too old if we are onboarding or doing a resume job
      if (daemonUtils.isLimitedAccount (argDict)) {
        messagesToDownload = _.filter (messages, function (msg) { 
          return msg.gmDate.getTime() >= argDict.minDateAccount.getTime()
        });
      }

      // TODO: test this filter
      // get rid of messages we don't download because of marketing material
      messagesToDownload = _.filter (messagesToDownload, function (msg) {
        if (msg.hasAttachment) {
          return true;
        } else if (msg.hasMarketingFrom || msg.hasMarketingText) {
          return false;
        } else {
          return true;
        }
      });

      var msgToDownloadLength = messagesToDownload.length;

      winston.doInfo ('msgToDownloadLength', {len : msgToDownloadLength});

      // there's nothing to download and the date isn't changing so we're getting
      // the same messages back over and over again, break out of the loop
      if (!msgToDownloadLength && maxDateBatch && newMaxDate.getTime() == maxDateBatch.getTime()) {
        winston.doInfo ('nothing to download and stagnant maxDate');
        callback ();
        return;
      }
      // there's nothing to download but the maxDate changed
      else if (!msgToDownloadLength) {
        daemonUtils.retrieveBatchRecurse (query, argDict, newMaxDate, callback);
        return;
      }

      argDict.minProcessedDate = messagesToDownload[msgToDownloadLength - 1].gmDate 

      imapRetrieve.getMessagesByUid (myConnection, userId,
        messagesToDownload, argDict.isUpdate, function (err, bandwithUsed) {
        
        if (err) {
          callback (winston.makeError ('error getting messages by uid' , {err : err}));
        }
        else {
          argDict.totalBandwith += bandwithUsed;
          winston.doInfo ('bandwith info', {userEmail : argDict.userEmail, batch : bandwithUsed, totalBandwith : argDict.totalBandwith});


          // update the bandwith numbers in the database
          if (argDict.isOnboarding) {
            daemonUtils.updateBandwithUsed (UserOnboardingStateModel, argDict.onboardingStateId, bandwithUsed);
          } else if (argDict.isResumeDownloading) {
            daemonUtils.updateBandwithUsed (ResumeDownloadStateModel, argDict.resumeDownloadingId, bandwithUsed);            
          }

          // we asked for EMAIL_FETCH_BATCH_SIZE, but mongo gave us less or the max is negative... so we must have everything
          // and don't need to schedule a resume for this user
          if (msgLength < constants.EMAIL_FETCH_BATCH_SIZE || daemonUtils.accountLimitReached (argDict)) {
            winston.doInfo('retrieveBatchRecurse: Not retrieving emails anymore: no emails left to process for user', logInfo);
            daemonUtils.updateMinProccessedDateForUser (argDict.userId, argDict.minProcessedDate, callback);
          }
          // we can still get more messages
          else if (argDict.totalBandwith < constants.MAX_BANDWITH_TOTAL ) {

            daemonUtils.updateMinProccessedDateForUser (argDict.userId, argDict.minProcessedDate, function (err) {
              if (err) {
                winston.handleError (err);
              }

              daemonUtils.retrieveBatchRecurse (query, argDict, newMaxDate, callback);
            });
          }
          // done for now, but need to schedule a resume
          else {
            
            if (!argDict.needsResume) {
              argDict.needsResume = true
            }

            winston.doInfo('retrieveBatchRecurse: Not retrieving emails anymore: total bandwith used up', {totalBandwith : argDict.totalBandwith});
            callback ();
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
      else {        //TODO: figure out what to do in this case
        if (foundMailbox.uidValidity != mailbox.uidvalidity) {
          winston.doError ("Uid validity mismatch", mailbox);
          return callback (err);
        }

        argDict.maxUid = foundMailbox.uidNext-1;
        argDict.mailboxId = foundMailbox._id;
        
        // just callback without updating state
        callback (null, argDict);
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
        winston.doError ("Uid validity mismatch", {malbox : mailbox, dbMailboxId : foundMailbox._id});
        return callback (err);
      }
      
      winston.doInfo ('lookupMailbox : state', {isUpdate : argDict.isUpdate, isResumeDownloading : argDict.isResumeDownloading});
      winston.doInfo ('lookupMailbox : uid nexts', {mailbox : mailbox.uidnext, foundMailbox : foundMailbox.uidNext});

      // if this is an update (i.e. get future email), but we don't 
      // have any difference in uids then that must mean there's nothing to fetch
      if (mailbox.uidnext == foundMailbox.uidNext && argDict.isUpdate) {
        callback ({warning : 'nothing to update, break chain'});
      }
      // fetch the future
      else if (argDict.isUpdate) {
        argDict.minUid = foundMailbox.uidNext;
        argDict.maxUid = '*';
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
    argDict.minUid, argDict.maxUid, argDict.onboardingStateId, argDict.mailbox.folderNames,
    function (err) {
      if (err) {
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
    argDict.minUid, argDict.maxUid, argDict.onboardingStateId, argDict.recoveryMode, argDict.mailbox.folderNames,
    function (err) {
      if (err) {
        callback (err);
      }
      else {
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      }
    });

  imapRetrieve.getHeadersInBatches(argDict,
    function (err) {
      if (err) {
        callback (err);
      }
      else {
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      }
    });



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

  MailModel.mapReduce(o, function (err){
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


exports.markAttachments = function markAttachments (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  // recovery case, we must have the headers in the DB already
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != functionName) {
    return callback (null, argDict);
  }


  imapRetrieve.getIdsOfMessagesWithAttachments (argDict.myConnection, argDict.minUid, argDict.maxUid, function (err, uids) {
    if (err) {
      callback (err);
    }
    else {
      daemonUtils.updateMailModel (uids, argDict.userId, 
        {hasAttachment : true},
        function (err){
          if (err) {
            callback (err)
          } else {
            daemonUtils.updateStateAndCallback (functionName, argDict, callback);
          }
        });
    }
  })

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

exports.setMinDate = function setMinDate (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  var query = {
    userId : argDict.userId,
    mmDone : {$exists : false}    
  }

  MailModel.findOne (query)
    .sort ('-gmDate')
    .exec (function (err, maxMail) {
      if (err) {
        callback (winston.makeMongoError (err));
      } else if (!maxMail) {
        argDict.minDate = argDict.minDateAccount;
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      } else {
        argDict.minDate = maxMail.gmDate;
        winston.doInfo ('setting min date', {gmDate : maxMail.gmDate});
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      }
    });

}


exports.setMaxDate = function setMaxDate (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  var query = {
    userId : argDict.userId,
    mmDone : {$exists : false}    
  }

  MailModel.findOne (query)
    .sort ('-gmDate')
    .exec (function (err, maxMail) {
      if (err) {
        callback (winston.makeMongoError (err));
      } else if (!maxMail) {
        argDict.maxDate = new Date(Date.now());
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      } else {
        argDict.maxDate = maxMail.gmDate;
        winston.doInfo ('setting max date', {gmDate : maxMail.gmDate});
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      }
    });

}


exports.retrieveEmails = function retrieveEmails (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != 'retrieveEmails') {
    return callback (null, argDict);
  }

  var query = {
    userId : argDict.userId,
    mmDone : {$exists : false}
  }

  daemonUtils.retrieveBatchRecurse (query, argDict, argDict.maxDate, function (err) {
    if (err) {
      callback (winston.makeError ('Error recursively getting emails', {err : err}));
    }
    else {
      daemonUtils.updateStateAndCallback (functionName, argDict, callback);
    }
  });

}

exports.markMinDateForUser = function markMinDateForUser (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail, totalBandwith : argDict.totalBandwith, needsResume : argDict.needsResume});

  // two queries so we can optimize to use index on userId, mmDone, gmDate

  var userId = argDict.userId;
  async.parallel ([
    function (cb) {
      MailModel.findOne ({userId : userId, mmDone : true})
        .sort ('gmDate')
        .exec (function (err, minMail) {
          if (err) { 
            cb (winston.makeMongoError (err)); 
          } else if (!minMail) {
            cb (null, new Date(Date.now()));
          } else {
            cb (null, minMail.gmDate);
          }
        });
    },
    function (cb) {
      MailModel.findOne ({userId : userId, mmDone : {$exists : false}})
        .sort ('gmDate')
        .exec (function (err, minMail) {
          if (err) { 
            cb (winston.makeMongoError (err)); 
          } else if (!minMail) {
            cb (null, new Date(Date.now()));
          } else {
            cb (null, minMail.gmDate);
          }
        });
    }
  ],
  function (err, results) {
    if (err) {
      callback (err);
    } else {
      winston.doInfo ('min overall date', {min : Math.min (results[0], results[1])});
      UserModel.update ({_id : userId}, 
        {$set : {minMailDate : Math.min (results[0], results[1]) }},
        function (err, num) {
          if (err) {
            callback (winston.makeMongoError (err));
          } else if (num == 0) {
            callback (winston.makeError ('could not find user to update', {userId : userId}));
          } else {
            daemonUtils.updateStateAndCallback (functionName, argDict, callback);
          }
        });       

    }
  });
}


exports.markStoppingPoint = function markStoppingPoint (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail, totalBandwith : argDict.totalBandwith, needsResume : argDict.needsResume});

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

  // find the max mailObject in the database
  MailModel.find ({userId : argDict.userId})
    .sort ('-uid')
    .select ('uid')
    .limit (1)
    .exec (function (err, foundMails) {
      if (err) {
        callback (winston.makeMongoError ('Error finding top uid in mail model', err));
      }
      else if (foundMails.length === 0) {
        winston.doWarn ("update mailbox didn't find any mail messages!", {userId : argDict.userId, userEmail: argDict.userEmail});
        callback (null, argDict);
      }
      else {
        var maxUid = foundMails [0].uid;

        MailBox.update ({_id : argDict.mailboxId},
          {$set : {uidNext : maxUid + 1, lastUpdate : Date.now()}},
          function (err, numAffected) {
            winston.doInfo(numAffected + " mailboxes updated uid next");
            callback (null, argDict);
          });

      }
    })

}
