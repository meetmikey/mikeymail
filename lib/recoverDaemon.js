var serverCommon = process.env.SERVER_COMMON;

//TODO: fix imports
var constants = require ('../constants'),
    imapConnect = require ('./imapConnect'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    async = require ('async'),
    cloudStorageUtils = require (serverCommon + '/lib/cloudStorageUtils'),
    uploadUtils = require ('./uploadUtils'),
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose;

var recoverDaemon = this;
var MailModel = mongoose.model ('Mail');

MailModel.find ({s3Path : {$exists : true}, mailReaderState : {$exists : false}}, 's3Path _id userId uid ', function (err, foundMails) {
  if (err) {
    winston.doMongoError ('recoverDaemon could not get mail', {err : err});
  }
  else if (foundMails) {
    foundMails.forEach (function (mail) {
      var inAzure = true;
      sqsConnect.addMessageToMailReaderQueue ({'userId' : mail.userId, 'path' : mail.s3Path, 'mailId' : mail._id, 'inAzure' : inAzure});
    });
  }
});