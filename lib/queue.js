var constants = require ('../constants'),
    async = require ('async'),
    imap = require('./imapConnect')


// create a queue object with concurrency MAX_DOWNLOAD_JOBS
var q = async.queue(function (task, callback) {

  // set up imap connection

  // download all files in last year and store in S3

  // download all 

}, constants.MAX_DOWNLOAD_JOBS);

// assign a callback
q.drain = function() {
  console.log('all items have been processed');
}

q.push({name: 'bar'}, function (err) {
  console.log('finished processing bar');
});

// add some items to the queue (batch-wise)

q.push([{name: 'baz'},{name: 'bay'},{name: 'bax'}], function (err) {
  console.log('finished processing bar');
});


function downloadAttachments (connection, callback) {

  var user = task.userId

}

exports.addDownloadJob = function (task, callback) {

  q.push(task, callback);

}
