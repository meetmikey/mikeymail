//TODO: fix imports
var constants = require ('../constants'),
    imapConnect = require ('./imapConnect'),
    imapRetrieve = require ('./imapRetrieve'),
    knox = require (constants.SERVER_COMMON + '/lib/s3Utils').client,
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    fs = require ('fs'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    conf = require (constants.SERVER_COMMON + '/conf'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    async = require ('async'),
    xoauth2 = require("xoauth2"),
    daemonUtils = require ('./daemonUtils'),
    xoauth2gen;


var MailBox = mongoose.model ('MailBox')
var MailModel = mongoose.model ('Mail')
var UserOnboardingStateModel = mongoose.model ('UserOnboardingState')

var daemonUtils = this

exports.updateStateAndCallback = function (onboardingStateId, functionName, argDict, callback) {
  daemonUtils.updateState (onboardingStateId, functionName, function () {
    daemonUtils.setArgDictRecoveryState (argDict, functionName)
    callback (null, argDict)
  })
}

// resolve the recovery mode flag once we finish the function that the recovery mode started at
exports.setArgDictRecoveryState = function (argDict, functionName) {
  if (argDict.recoveryMode && argDict.recoveryModeStartPoint == functionName) {
    argDict.recoveryMode = false
  }
}


exports.updateState = function (stateId, newState, cb) {
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

exports.updateErrorState = function (stateId, errorMsg) {
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

exports.updateMailModel = function (uids, userId, setExpression, callback) {

  if (!uids || (uids && uids.length == 0)) { return callback () }

  var resultsAsInt = uids.map (function (elem) { return parseInt(elem)})

  MailModel.update ({userId : userId, 'uid' : {$in : resultsAsInt}}, 
    {$set : setExpression}, 
    {multi : true})
    .exec(callback)

}

exports.retrieveBatchRecurse = function (myConnection, query, argDict, maxUid, isAttachment, callback) {

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
              winston.info('retrieveBatchRecurse: Not retrieving emails anymore: no emails left to process with isAttachment: ' + isAttachment)
              callback ()
            }
            else if (argDict.totalBandwith < constants.MAX_BANDWITH_TOTAL) {

              // sub-conditions for isAttachment
              if (isAttachment && argDict.attachmentBandwith > constants.MAX_BANDWITH_ATTACHMENT) {
                winston.info('retrieveBatchRecurse: Not retrieving emails anymore: attachment bandwith used up: ' + argDict.attachmentBandwith)
                callback (null)
              }
              else {
                daemonUtils.retrieveBatchRecurse (myConnection, query, argDict, newMaxUid, isAttachment, callback)
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