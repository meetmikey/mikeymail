var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants')
    , cloudStorageUtils = require (serverCommon + '/lib/cloudStorageUtils')
    , mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose
    , winston = require (serverCommon + '/lib/winstonWrapper').winston
    , sqsConnect = require(serverCommon + '/lib/sqsConnect')

var MailModel = mongoose.model ('Mail')

var uploadUtils = this;


exports.uploadBufferToCloud = function (buffer, cloudPath, headers, userId, uid, isUpdate, callback) {
  winston.doInfo ('uploadBufferToCloud', {uid : uid, userId : userId});
  var useGzip = false;
  var inAzure = constants.USE_AZURE;

  cloudStorageUtils.putBuffer (buffer, cloudPath, headers, useGzip, inAzure, 
    function (err) {
      var query = {'userId' : userId, 'uid' : uid};
      if (err) {
        callback (err);
      } else {
        // update mail table
        MailModel.findOneAndUpdate (query, 
          {$set : {s3Path : cloudPath, inAzure : inAzure}},
          function (err, updatedMailRecord) {
            if (err) {
              callback (winston.makeMongoError (err));
            } else if (!updatedMailRecord) {
              callback (winston.makeError ('could not find mail to update s3Path', 
                {query : query}));
            } else {

              var message = {
                  'userId': userId
                , 'path': cloudPath
                , 'mailId': updatedMailRecord._id
                , 'inAzure': inAzure
              };

              var queueFunction = sqsConnect.addMessageToMailReaderQueue;
              if (isUpdate) {
                queueFunction = sqsConnect.addMessageToMailReaderQuickQueue;
              }

              queueFunction( message, function(err) {
                if (err) {
                  callback (err);
                } else {
                  uploadUtils.setMikeyMailState (query, callback);
                }
              });
            }
          });
        }
    });
}


exports.setMikeyMailState = function (query, callback) {
  MailModel.update (query,
    {$set : {mmDone : true}},
    function (err, numAffected) {
      if (err) {
        callback(winston.makeError ('MongoErr: Could not set mmDone state in mikeyMail', {query : query}));
      } else if (numAffected === 0) {
        callback(winston.makeError ('Could not set mmDone state in mikeyMail', {query : query}));
      } else {
        winston.doInfo ('mikeymail is done with', query);
        callback();
      }
    });
}