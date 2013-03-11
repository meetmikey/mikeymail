var constants = require ('../constants')
    , conf = require (constants.SERVER_COMMON + '/conf')
    , knoxClient = require (constants.SERVER_COMMON + '/lib/s3Utils').client
    , cloudStorageUtils = require (constants.SERVER_COMMON + '/lib/cloudStorageUtils')
    , mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose
    , winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston
    , sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect')

var MailModel = mongoose.model ('Mail')

var uploadUtils = this;


exports.uploadBufferToCloud = function (buffer, awsPath, headers, userId, uid, isUpdate) {

  var useGzip = false;
  var inAzure = constants.USE_AZURE;

  cloudStorageUtils.putBuffer (buffer, awsPath, headers, false, inAzure, function (err) {
    if (err) {
      // write to mail model that upload failed
      var query = {'uid': uid, 'userId' : userId};

      MailModel.update (query, {$set : {failUpload : true}}, function (err) {
        if (err) { winston.doError ('could not update model failed to uploadToS3', err); }
      });
    }
    else {

      var query = {'uid': uid, 'userId' : userId};

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