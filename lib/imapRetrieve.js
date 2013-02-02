var Imap = require('imap'),
    inspect = require('util').inspect,
    constants = require ('../constants'),
    conf = require ('../conf'),
    fs = require('fs'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    knoxClient = require (constants.SERVER_COMMON + '/lib/s3Utils').client;


var imapRetrieve = this;

exports.imapGetBySearch = function (imapConn, criteria, userId, getAllMessagesCallback) {

  fs.mkdir (constants.TEMP_FILES_DIR + '/' + userId, function (err) {

    if (err) {
      winston.error ("Error: could not make directory", constants.TEMP_FILES_DIR + '/' + userId)
    }

    var awsDirectory = constants.AWS_RAW_MSG_DIR + '/attachments/' + userId

    imapConn.search(criteria, function(err, results) {
      if (err) closeConnection(err);
      imapConn.fetch(results,
        { headers: { parse: false },
          body: true,
          cb: function(fetch) {
            fetch.on('message', function(msg) {
              console.log('Got a message with sequence number ' + msg.seqno);
              var filename = constants.TEMP_FILES_DIR + '/' + userId + '/msg-' + msg.seqno + '-body.txt'
             
              fileStream = fs.createWriteStream(filename);
              
              msg.on('data', function(chunk) {
                fileStream.write(chunk);
              });
              
              msg.on('end', function() {
                fileStream.end();

                var filename = constants.TEMP_FILES_DIR + '/' + userId + '/msg-' + msg.seqno + '-body.txt'
                console.log ('filename', filename)

                var headers = {
                  'Content-Type': 'text/plain'
                  , 'x-amz-server-side-encryption' : 'AES256'
                };

                var awsPath = awsDirectory + '/' + msg.seqno + '-body.txt'
                console.log  ('awsPath', awsPath)

                knoxClient.putFile(filename, awsPath, headers, 
                  function(err, res){
                    
                    if (err) {
                      console.error ('error uploading file', err)
                      console.error ('filename:', filename)
                    }
                    else{
                      console.log ('statusCode', res.statusCode)
                      if (res.statusCode !== 200) {
                        console.log ('non 200 status code', res.statusCode)
                      }
                      else {
                        console.log ('uploaded to s3, add msg to queue', awsPath)
                        sqsConnect.addMessageToMailReaderQueue ({'userId' : userId, 'path' : awsPath})
                      }

                    }
                
                })

                console.log('Finished message no. ' + msg.seqno);
              });
            });
          }
        }, function(err) {
          //TODO:

          console.log ('all done')
          getAllMessagesCallback (null)
        }      
      );
    });


  })

}

exports.getRecentMessages = function () {

}

exports.getMessagesWithAttachments = function (imapConn, since, userId, callback) {
  imapRetrieve.imapGetBySearch (imapConn, [ ['X-GM-RAW', 'has:attachment'], ['SINCE', since]], userId, function (err) {
    if (err) closeConnection(err); //TODO: change this

    console.log ('getMessagesWithAttachments done')
    callback (err)
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

