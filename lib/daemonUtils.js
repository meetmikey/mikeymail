var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants'),
    imapRetrieve = require ('./imapRetrieve'),
    sesUtils = require (serverCommon + '/lib/sesUtils'),
    sqsConnect = require (serverCommon + '/lib/sqsConnect'),
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
var BandwithModel = mongoose.model ('Bandwith');

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

exports.setUserAllMailError = function (isOnboarding, user, errorType, callback) {

  var duplicateError = false;
  if (user.allMailError) {
    duplicateError = true;
  }
  user.allMailError = true;

  if (isOnboarding) {
    user.allMailOnboardAttempts += 1;
  }

  user.save (function (err) {
    if (err) {
      callback (winston.makeMongoError (err));
    } else {
      // onboarding, not duplicate - notify + recreate delayed queue job
      if (!duplicateError && isOnboarding) {
        winston.doInfo ('not a duplicate, isOnboarding');
        sesUtils.sendAllMailDoesntExistNotification (isOnboarding, user.email, function (err) {
          if (err) {
            callback (err);
          } else {
            if (user.allMailOnboardAttempts < constants.MAX_ALLMAIL_ONBOARDING_ATTEMPTS) {
              sqsConnect.addMessageToMailDownloadQueue (user, constants.ALLMAIL_ERROR_REQUEUE_DELAY, function (err) {
                callback (err);
              });              
            } else {
              callback();
            }
          }
        });
      } 
      // not onboarding, not duplicate - notify the user that mikey needs all mail
      else if (!duplicateError && !isOnboarding) {
        winston.doInfo ('not a duplicate, not onboarding');
        sesUtils.sendAllMailDoesntExistNotification (isOnboarding, user.email, function (err) {
          if (err) {
            callback (err);
          }
        });
      } 
      // onboarding but we've already sent an email, just create queue job 15 mins from now
      else if (duplicateError && isOnboarding) {
        winston.doInfo ('duplicate, onboarding');
        if (user.allMailOnboardAttempts < constants.MAX_ALLMAIL_ONBOARDING_ATTEMPTS) {
          sqsConnect.addMessageToMailDownloadQueue (user, constants.ALLMAIL_ERROR_REQUEUE_DELAY, function (err) {
            callback (err);
          });              
        } else {
          sesUtils.sendInternalNotificationEmail ('exhausted all attempts to onboard user ' + user.email, 'all mail error max tries exceeded', callback);
        }
      }
      // duplicate, not onboarding - nothing to do
      else {
        callback();
      }
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

exports.updateMinProcessedDateForUser = function (userId, minProcessedDate, callback) {
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
    return (argDict.minProcessedDate.getTime() < argDict.minDate.getTime());
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

exports.getXOauthParams = function (user) {

  // note: accessToken is assumed to be valid
  var params = {
    user: user.email,
    clientId: conf.google.appId,
    clientSecret: conf.google.appSecret,
    refreshToken: user.refreshToken,
    accessToken : user.accessToken
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

exports.updateBandwithUsed = function (userId, bandwith) {
  if (!bandwith || bandwith <= 0) { return; }

  var today = daemonUtils.getTodayDateString();

  // figure out if anything exists for the current day
  BandwithModel.update ({userId : userId, dateString: today}, 
    {$inc : {'bandwith' : bandwith}}, 
    {upsert : true}, function (err, num) {
      if (err) {
        winston.doMongoError (err);
      } else if (num == 0) {
        winston.doWarn ('No records affected when updating bandwith', {userId : userId, today : today});
      } else {
        winston.doInfo ('Bandwith updated in database for:', {userId : userId, today : today});
      }
    });
}


exports.getBandwithForUserDay = function (userId, callback) {
  var today = daemonUtils.getTodayDateString();

  BandwithModel.findOne ({userId : userId, dateString : today}, function (err, bandwithModel) {
    if (err) {
      callback (winston.makeMongoError (err));
    } else if (!bandwithModel) {
      callback (null, 0);
    } else {
      callback (null, bandwithModel.bandwith);
    }
  });
}

exports.getTodayDateString = function() {
  var d = new Date();
  var year = d.getFullYear().toString();
  var month = (d.getMonth()+1).toString();
  var day = d.getDate().toString();

  if (parseInt(month) < 10) month = "0" + month;
  if (parseInt(day) < 10) day = "0" + day;

  return year + month + day;
}


exports.retrieveBatchRecurse = function (query, argDict, maxDateBatch, callback) {

  var logInfo = {
    userEmail : argDict.userEmail,
    userId : argDict.userId,
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

  mongoQuery.select ('uid gmDate hasMarketingText hasMarketingFrom hasAttachment isMikeyLike');
  mongoQuery.sort ('-gmDate');

  mongoQuery.limit (constants.EMAIL_FETCH_BATCH_SIZE);

  // query database for messages that are attachments  
  mongoQuery.exec (function (err, messages) {
    if (err) {
      callback (winston.makeMongoError(err));
    }
    else {
      var msgLength = messages.length;
      winston.doInfo ('msgLength', {msgLength : msgLength});

      if (!msgLength) {
        return callback (); //here
      }

      var messagesToDownload = messages;

      // last element of array, minus 1 so we don't redo the current last msg
      var newMaxDate = messages[msgLength - 1].gmDate;
      winston.doInfo ('newMaxDate', {date : newMaxDate});

      // get rid of things with a date too old if we are onboarding or doing a resume job
      if (daemonUtils.isLimitedAccount (argDict)) {
        messagesToDownload = _.filter (messages, function (msg) { 
          return msg.gmDate.getTime() >= argDict.minDate.getTime()
        });
      }

      // get rid of messages we don't download because of marketing material
      messagesToDownload = _.filter (messagesToDownload, function (msg) {
        if (msg.isMikeyLike) {
          return false;
        }
        else if (msg.hasAttachment) {
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
        messagesToDownload, argDict.isUpdate,
        function (err, bandwithUsed) {
        
        if (err) {
          callback (err);
        }
        else {
          argDict.totalBandwith += bandwithUsed;
          winston.doInfo ('bandwith info', {userEmail : argDict.userEmail, batch : bandwithUsed, totalBandwith : argDict.totalBandwith});

          // update the bandwith numbers in the database
          if (argDict.isOnboarding || argDict.isResumeDownloading) {
            daemonUtils.updateBandwithUsed (userId, bandwithUsed);
          }

          // we asked for EMAIL_FETCH_BATCH_SIZE, but mongo gave us less... so we must have everything
          // and don't need to schedule a resume for this user
          if (msgLength < constants.EMAIL_FETCH_BATCH_SIZE || daemonUtils.accountLimitReached (argDict)) {
            winston.doInfo ('account limit reached?', {reached : daemonUtils.accountLimitReached (argDict)});
            winston.doInfo('retrieveBatchRecurse: Not retrieving emails anymore: no emails left to process for user', logInfo);
            daemonUtils.updateMinProcessedDateForUser (argDict.userId, argDict.minProcessedDate, callback); //here
          }
          // we can still get more messages
          else if (argDict.totalBandwith < constants.MAX_BANDWITH_TOTAL ) {

            daemonUtils.updateMinProcessedDateForUser (argDict.userId, argDict.minProcessedDate, function (err) {
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

            winston.doInfo('retrieveBatchRecurse: Not retrieving emails anymore for today: total bandwith used up', {totalBandwith : argDict.totalBandwith});
            daemonUtils.updateMinProcessedDateForUser (argDict.userId, argDict.minProcessedDate, callback);

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
        if (foundMailbox.uidValidity != mailbox.uidvalidity) {
          callback (winston.makeError ("Uid validity mismatch", {malbox : mailbox, dbMailboxId : foundMailbox._id}));
          sesUtils.sendInternalNotificationEmail ('uid validity mismatch for user ' + argDict.userEmail, 'uid validity mismatch', function (err) {});
          return;
        }

        argDict.maxUid = foundMailbox.uidNext-1;
        argDict.mailboxId = foundMailbox._id;
        
        // just callback without updating state
        callback (null, argDict);
      }
    });
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

      if (foundMailbox.uidValidity != mailbox.uidvalidity) {
        callback (winston.makeError ("Uid validity mismatch", {malbox : mailbox, dbMailboxId : foundMailbox._id}));
        sesUtils.sendInternalNotificationEmail ('uid validity mismatch for user ' + argDict.userEmail, 'uid validity mismatch', function (err) {});
        return;
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
  });

}



exports.retrieveHeaders = function retrieveHeaders (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  // recovery case we must have the headers in the DB already
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != functionName) {
    return callback (null, argDict);
  }

  imapRetrieve.getHeaders(argDict, argDict.minUid, argDict.maxUid, null,
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

  imapRetrieve.getHeadersInBatches(argDict,
    function (err) {
      if (err) {
        callback (err);
      } else {
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      }
    });
}


exports.getMoreHeadersForResume = function getMoreHeadersForResume (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  if (argDict.recoveryMode && argDict.recoveryModeStartPoint !== functionName) {
    winston.doWarn ('in recovery mode and starting point is past ', 
      {startPoint : argDict.recoveryModeStartPoint, functionName : functionName});
    return callback (null, argDict);
  }

  imapRetrieve.getMoreHeadersForResume(argDict,
    function (err) {
      if (err) {
        callback (err);
      } else {
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      }
    });

}

exports.markAttachments = function markAttachments (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  // recovery case, we must have the attachments marked in the DB already
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != functionName) {
    return callback (null, argDict);
  }

  if (argDict.isResumeDownloading && !argDict.uidArray || (argDict.uidArray && !argDict.uidArray.length)) {
    return callback (null, argDict);
  }

  imapRetrieve.getIdsOfMessagesWithAttachments (argDict.myConnection, argDict.minUid, argDict.maxUid, argDict.uidArray, 
    function (err, uids) {
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
    });
}

exports.markMarketingFromEmails = function markMarketingFromEmails (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  // recovery case, we must have the headers in the DB already
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != functionName) {
    return callback (null, argDict);
  }

  if (argDict.isResumeDownloading && !argDict.uidArray || (argDict.uidArray && !argDict.uidArray.length)) {
    return callback (null, argDict);
  }


  imapRetrieve.getMarketingFromIds (argDict.myConnection, argDict.minUid, argDict.maxUid, argDict.uidArray, 
    function (err, uids) {
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
    });
}

exports.markMarketingTextEmails = function markMarketingTextEmails (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  // recovery case, we must have the headers in the DB already
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint != functionName) {
    return callback (null, argDict);
  }

  if (argDict.isResumeDownloading && !argDict.uidArray || (argDict.uidArray && !argDict.uidArray.length)) {
    return callback (null, argDict);
  }


  imapRetrieve.getMarketingTextIds (argDict.myConnection, argDict.minUid, argDict.maxUid, argDict.uidArray,
    function (err, uids) {
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
    });
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
        // there's no mail in account... so keep minDate as default value
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      } else {
        argDict.minDate = maxMail.gmDate;
        winston.doInfo ('setting min date', {gmDate : maxMail.gmDate});
        daemonUtils.updateStateAndCallback (functionName, argDict, callback);
      }
    });

}

// sets the maxDate on argDict - representing the date of the most recent mail
// we have in the database for this user. This is later used when retrieving
// emails to fetch from the db to constrict to a date range.
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

exports.markMinMailDateForUser = function markMinMailDateForUser (userId, date) {
  winston.doInfo ('markMinMailDateForUser');
  UserModel.update ({_id : userId, minMailDate : {$gt : date}}, 
    {$set : {minMailDate : date}},
    function (err, num) {
      if (err) {
        winston.doMongoError (err);
      } else {
        winston.doInfo ('mark min mail date num affected', {num : num});
      }
    });
}

exports.getMinMailDateInDbForUser = function getMinMailDateInDbForUser (userId, callback) {

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
        var minDate = Math.min (results[0], results[1]);
        winston.doInfo ('min overall date', {min : minDate});
        callback (null, minDate);
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

    // spoof the lastCompleted step since we shouldn't have to fetch headers
    // again on the next day when we resume again...
    if (argDict.isResumeDownloading && argDict.isPremium) {
      resume.isPremium = true;
      resume.maxDate = argDict.maxDate;
      resume.lastCompleted = 'markMarketingTextEmails';
    } else {
      resume.minDate = argDict.minDate;
      resume.maxDate = argDict.maxDate;
      resume.lastCompleted = 'markMarketingTextEmails';
    
      if (argDict.isPremium) {
        resume.isPremium = true;
      }
    }

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

// runs at end of onboarding so that resumes know where to pick up from
exports.setLastResumeDownloadDate = function setLastResumeDownloadDate (argDict, callback) {
  var functionName = arguments.callee.name;
  winston.doInfo (functionName, {email : argDict.userEmail});

  daemonUtils.getMinMailDateInDbForUser (argDict.userId, function (err, minDate) {
    if (err) {
      callback (err);
    } else {
      UserModel.update ({_id : argDict.userId}, {$set : {lastResumeJobEndDate : minDate}}, function (err, num) {
        if (err) {
          callback (winston.makeMongoError (err));
        } else {
          daemonUtils.updateStateAndCallback (functionName, argDict, callback);
        }
      });      
    }
  });
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
    });
}