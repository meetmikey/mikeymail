var Imap = require('imap'),
    inspect = require('util').inspect,
    fs = require('fs');


var imapRetrieve = this;

exports.imapGetBySearch = function (imapConn, criteria, getMessagesCallback) {

  imap.search(criteria, function(err, results) {
    if (err) closeConnection(err);
    imap.fetch(results,
      { headers: { parse: false },
        body: true,
        cb: function(fetch) {
          fetch.on('message', function(msg) {
            console.log('Got a message with sequence number ' + msg.seqno);
            fileStream = fs.createWriteStream(constants.TEMP_FILES_DIR + '/msg-' + msg.seqno + '-body.txt');
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
        //TODO:

        console.log ('all done')
        getMessagesCallback (null)
      }      
    );
  });

}

exports.getRecentMessages = function () {

}

exports.getMessagesWithAttachments = function (imapConn, since) {
  if (err) closeConnection(err); //TODO: change this
  imapRetrieve.imapGetBySearch ([ ['X-GM-RAW', 'has:attachment'], ['SINCE', since]], function (err) {
    console.log ('get message callback')
  })
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

