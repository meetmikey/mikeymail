var constants = require ('../constants')
    , conf = require (constants.SERVER_COMMON + '/conf')
    , mongoUtils = require (constants.SERVER_COMMON + '/lib/mongoUtils')
    , cloudStorageUtils = require (constants.SERVER_COMMON + '/lib/cloudStorageUtils')
    , mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose
    , winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston
    , sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect')

var MailModel = mongoose.model ('Mail')

var uploadUtils = this;


exports.uploadBufferToCloud = function (buffer, awsPath, headers, userId, uid, isUpdate) {

  var useGzip = false;
  var inAzure = constants.USE_AZURE;

  cloudStorageUtils.putBuffer (buffer, awsPath, headers, useGzip, inAzure, function (err) {
    var query = {'uid': uid, 'userId' : userId, 'shardKey': mongoUtils.getShardKeyHash(userId) };

    if (err) {
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
            // push messages except pure local testing
            if (!constants.DONT_QUEUE_LOCALHOST) {
              if (isUpdate) {
                sqsConnect.addMessageToMailReaderQuickQueue ({'userId' : userId, 'path' : awsPath, 'mailId' : updatedMailRecord._id, 'inAzure' : inAzure});
              }
              else {
                sqsConnect.addMessageToMailReaderQueue ({'userId' : userId, 'path' : awsPath, 'mailId' : updatedMailRecord._id, 'inAzure' : inAzure});
              }
            }
          }
        })
      };

  });


}