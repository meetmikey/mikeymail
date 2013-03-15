var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    sqsConnect = require (serverCommon + '/lib/sqsConnect'),
    cloudStorageUtils = require (serverCommon + '/lib/cloudStorageUtils'),
    uploadUtils = require ('./uploadUtils'),
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose;

var MailModel = mongoose.model ('Mail');

MailModel.find ({s3Path : {$exists : true}, mailReaderState : {$exists : false}}, 
  's3Path _id userId uid', 
  function (err, foundMails) {
  if (err) {
    winston.doMongoError ('Could not get mail', {err : err});
  }
  else if (foundMails) {
    foundMails.forEach (function (mail) {
      var inAzure = true;
      sqsConnect.addMessageToMailReaderQueue ({'userId' : mail.userId, 'path' : mail.s3Path, 'mailId' : mail._id, 'inAzure' : inAzure});
    });
  }
});