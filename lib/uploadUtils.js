var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants')
    , conf = require (serverCommon + '/conf')
    , mongoUtils = require (serverCommon + '/lib/mongoUtils')
    , cloudStorageUtils = require (serverCommon + '/lib/cloudStorageUtils')
    , mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose
    , winston = require (serverCommon + '/lib/winstonWrapper').winston
    , sqsConnect = require(serverCommon + '/lib/sqsConnect')

var MailModel = mongoose.model ('Mail')

var uploadUtils = this;


exports.uploadBufferToCloud = function (buffer, awsPath, headers, userId, uid, isUpdate) {

  var useGzip = false;
  var inAzure = constants.USE_AZURE;

  cloudStorageUtils.putBuffer (buffer, awsPath, headers, useGzip, inAzure, function (err) {
    var query = {'userId' : userId, 'uid' : uid};

    if (err) {
      //TODO: get rid of this
      cloudStorageUtils.markFailedUpload(MailModel, 'mail', query);
    }
    else {
      // update mail table
      MailModel.findOneAndUpdate (query, 
        {$set : {s3Path : awsPath}}, 
        function (err, updatedMailRecord) {
          if (err) {
            winston.doError ('could not update model s3Path', err);
          }
          else if (!updatedMailRecord) {
            winston.doError ('zero records affected in update of record', query);
          }
          else {
            var message = {
                'userId': userId
              , 'path': awsPath
              , 'mailId': updatedMailRecord._id
              , 'inAzure': inAzure
            };
            if (isUpdate) {
              sqsConnect.addMessageToMailReaderQuickQueue( message, function(err) {
                if (err) {
                  winston.handleError(err);
                } else {
                  uploadUtils.setMikeyMailState (query);
                }
              });
            }
            else {
              sqsConnect.addMessageToMailReaderQueue( message, function(err) {
                if ( err ) {
                  winston.handleError(err);
                } else {
                  uploadUtils.setMikeyMailState (query);
                }
              });
            }
          }
        })
      };

  });


}


exports.setMikeyMailState = function (query) {
  MailModel.findOneAndUpdate (query,
    {$set : {mmDone : true}},
    function (err, updatedMailRecord) {
      if (err) {
        winston.doError ('Could not set mmDone state in mikeyMail');
      } else if (!updatedMailRecord) {
        winston.doError ('Zero records affected in update of mmDone state', query);
      } else {
        winston.doInfo ('mikeymail is done with', query);
      }
    });
}