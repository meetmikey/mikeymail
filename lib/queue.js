var constants = require ('../constants'),
    async = require ('async'),
    imapLib = require('./imapLib')


// create a queue object with concurrency MAX_DOWNLOAD_JOBS
var q = async.queue(function (task, callback) {

  // set up imap connection for this user

  // download batches and push to s3

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


function downloadBatches (connection, callback) {

  async.

}

exports.addDownloadJob = function (task, callback) {

  q.push(task, callback);

}


