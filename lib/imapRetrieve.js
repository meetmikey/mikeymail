var Imap = require('imap'),
    inspect = require('util').inspect,
    fs = require('fs');


var imapRetrieve = this

exports.imapGetBySearch = function (imapConn, criteria, cb) {

  imap.search(criteria, function(err, results) {
    if (err) closeConnection(err);
    imap.fetch(results,
      { headers: { parse: false },
        body: true,
        cb: function(fetch) {
          fetch.on('message', function(msg) {
            console.log('Got a message with sequence number ' + msg.seqno);
            fileStream = fs.createWriteStream('msg-' + msg.seqno + '-body.txt');
            msg.on('data', function(chunk) {
              fileStream.write(chunk);
            });
            msg.on('end', function() {
              fileStream.end();
              console.log('Finished message no. ' + msg.seqno);
            });
          });
        }
      }, function(err) {

      }      
    );
  });

}

exports.getRecentMessages = function () {

}

exports.getMessagesWithAttachments = function (imapConn, since, cb) {
  if (err) closeConnection(err); //TODO: change this
  imapRetrieve.imapGetBySearch ([ ['X-GM-RAW', 'has:attachment'], ['SINCE', since]])
}

function show(obj) {
  return inspect(obj, false, Infinity);
}

function die(err) {
  console.error('Uh oh: ' + err);
  process.exit(1);
}

function closeConnection (err) {
  console.error ("Error: ", err)
  process.exit (1)
}

