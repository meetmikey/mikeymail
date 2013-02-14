var constants = require ('../constants')
    , conf = require (constants.SERVER_COMMON + '/conf')
    , knoxClient = require (constants.SERVER_COMMON + '/lib/s3Utils').client
    , mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose
    , winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston
    , sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect')

var MailModel = mongoose.model ('Mail')

var uploadUtils = this;


exports.uploadFileToS3 = function (filename, awsPath, headers, userId, uid, attempts) {

  knoxClient.putFile(filename, awsPath, headers, 
    function(err, res){     
      if (err) {
        winston.doError ('error uploading file', {'error' : err, 'filename' : filename, 'aws path' : awsPath})
        retry()
      }
      else{
        if (res.statusCode !== 200) {
          winston.doError ('Error: non 200 status code', {'statusCode' : res.statusCode, 'filename' : filename, 'aws path' : awsPath})
          retry()
        }
        else {

          var query = {'uid': uid, 'userId' : userId}

          // update mail table
          MailModel.findOneAndUpdate (query, 
            {$set : {s3Path : awsPath}}, 
            function (err, updatedMailRecord) {
              if (err) {
                winston.doError ('could not update model s3Path', err)
              }
              else if (!updatedMailRecord) {
                winston.doError ('zero records affected in update of record', query)
              }
              else {
                // push messages except pure local testing
                if (constants.USE_MONGO_HQ || constants.ENV != 'localhost') {
                  sqsConnect.addMessageToMailReaderQueue ({'userId' : userId, 'path' : awsPath, 'mailId' : updatedMailRecord._id})
                }
              }
            })
        }
      }
  })


  function retry () {
    // retry
    if (attempts < constants.S3_RETRIES) {
      winston.info ('Retrying upload for file: ' + filename)
      uploadUtils.uploadFileToS3 (filename, awsPath, headers, userId, uid, attempts + 1)
    }
    else {
      winston.doError ('Max upload attempts exceeded for file', {'filename' : filename})
    }
  }

}