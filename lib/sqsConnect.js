var conf = require ('../conf'),
    aws = require ('aws-lib'),
    async = require ('async'),
    constants = require ('../constants')

// See "http://docs.amazonwebservices.com/AWSSimpleQueueService/latest/APIReference/"
// General SQS actions do not require a "path" (CreateQueue, ListQueue, etc)

// Specific Queue options (CreateMessage, DeleteMessage, ReceiveMessage etc)
// need a specific path 
// http://sqs.us-east-1.amazonaws.com/123456789012/testQueue/
// /accountid/queue_name
var options = {
    "path" : "/315865265008/IndexingJobs"  
};


var 

var sqs = aws.createSQSClient(conf.aws.key, conf.aws.secret, options);


exports.addMessageToIndexingQueue = function (json) {

  var msg = JSON.stringify (json)

  var outbound = {
    MessageBody : msg  
  }

  sqs.call ( "SendMessage", outbound, function (err, result ) {
    console.log("send message to queue result: " + JSON.stringify(result)); 
  })

}

exports.receiveMessageFromIndexingQueue = function () {

  sqs.call ( "ReceiveMessage", {MaxNumberOfMessages : 1}, function (err, result) {

    console.log("receive message to queue result: " + JSON.stringify(result)); 

    return result

  });

}


exports.deleteMessageFromIndexingQueue = function () {



}


exports.startPollingForDownloadJobs = function () {
  // at most do x accounts at a time


}

