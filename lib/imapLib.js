var Imap = require('imap'),
    inspect = require('util').inspect;

// creates an imap connection to a single user account for initial download

var imap = new Imap({
      user: 'sagar@mikeyteam.com',
      password: 'Superm0n33MT',
      host: 'imap.gmail.com',
      port: 993,
      secure: true
    });

function show(obj) {
  return inspect(obj, false, Infinity);
}

function die(err) {
  console.log('Uh oh: ' + err);
  process.exit(1);
}

function openInbox(cb) {
  imap.connect(function(err) {
    if (err) die(err);
    imap.openBox('INBOX', true, cb);
  });
}
/*
openInbox(function(err, mailbox) {
  if (err) die(err);
  imap.search([ 'UNSEEN', ['SINCE', 'Jan 23, 2013'] ], function(err, results) {
    if (err) die(err);
    map.fetch(results,
      { headers: ['from', 'to', 'subject', 'date'],
        cb: function(fetch) {
          fetch.on('message', function(msg) {
            console.log('Saw message no. ' + msg.seqno);
            msg.on('headers', function(hdrs) {
              console.log('Headers for no. ' + msg.seqno + ': ' + show(hdrs));
            });
            msg.on('end', function() {
              console.log('Finished message no. ' + msg.seqno);
            });
          });
        }
      }, function(err) {
        if (err) throw err;
        console.log('Done fetching all messages!');
        imap.logout();
      }
    );
  });
});
*/
var fs = require('fs'), fileStream;

openInbox(function(err, mailbox) {
  if (err) die(err);

    imap.getBoxes (function (err, boxes) {
      console.log (boxes)
    })

  imap.search([ 'UNSEEN', ['SINCE', 'Jan 25, 2013'] ], function(err, results) {
    if (err) die(err);
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
});


