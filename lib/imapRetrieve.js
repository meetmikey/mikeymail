var Imap = require('imap'),
    inspect = require('util').inspect,
    constants = require ('../constants'),
    conf = require (constants.SERVER_COMMON + '/conf'),
    fs = require('fs'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    knoxClient = require (constants.SERVER_COMMON + '/lib/s3Utils').client;

var Mail = mongoose.model ('Mail')
var imapRetrieve = this;

exports.imapGetBySearch = function (imapConn, criteria, userId, getAllMessagesCallback) {

  fs.mkdir (constants.TEMP_FILES_DIR + '/' + userId, function (err) {

    //TODO : check if dir exists
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
              
              var filename = constants.TEMP_FILES_DIR + '/' + userId + '/msg-' + msg.seqno + '-body.txt'
             
              fileStream = fs.createWriteStream(filename);
              
              msg.on('data', function(chunk) {
                fileStream.write(chunk);
              });
              
              msg.on('end', function() {
                fileStream.end();
              })

              fileStream.on('close' , function () {

                var filename = constants.TEMP_FILES_DIR + '/' + userId + '/msg-' + msg.seqno + '-body.txt'

                var headers = {
                  'Content-Type': 'text/plain'
                  , 'x-amz-server-side-encryption' : 'AES256'
                };

                var awsPath = awsDirectory + '/' + msg.seqno + '-body.txt'

                putFile (filename, awsPath, headers, 0)

                function putFile (filename, awsPath, headers, attempts) {

                  knoxClient.putFile(filename, awsPath, headers, 
                    function(err, res){
                      
                      if (err) {

                        console.error ('error uploading file', err)
                        console.error ('filename:', filename)

                        // retry
                        if (attempts < 2) {
                          console.log ('retrying')
                          putFile (filename, awsPath, headers, attempts + 1)
                        } 
                      }
                      else{
                        if (res.statusCode !== 200) {
                          console.log ('Error: non 200 status code', res.statusCode)
                        }
                        else {
                          sqsConnect.addMessageToMailReaderQueue ({'userId' : userId, 'path' : awsPath})
                        }

                      }
                  
                  })

                }

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


exports.getHeaders = function (imapConn, userId, mailboxId, maxUid, callback) {
  
  // TODO: see if we need to insert x records at a time 
  // var maxRecords = constants.OBJECTS_PER_MAIL_INSERT

  var currentLength = 0

  uidRange = '1:' + maxUid

  imapConn.fetch(uidRange,
    { headers: ['message-id'],
      cb: function(fetch) {
        fetch.on('message', function(msg) {

          var mailObject = new Mail ({
            'userId' : userId,
            'mailboxId' : mailboxId
          })

          msg.on('headers', function(hdrs) {
            mailObject ['messageId'] = hdrs['message-id']
          });

          msg.on('end', function() {

            mailObject ['uid'] = msg.uid
            mailObject ['seqNo'] = msg.seqno

            if(msg['date']) {
              mailObject['gmDate'] = new Date( Date.parse( msg['date'] ) );
            }

            if (msg['x-gm-thrid']) {
              mailObject.gmThreadId = msg['x-gm-thrid']
            }

            if (msg['x-gm-msgid']) {
              mailObject.gmMsgId = msg['x-gm-msgid']
            }

            if (msg['x-gm-labels']) {
              mailObject.gmLabels = []

              msg['x-gm-labels'].forEach (function (label) {
                mailObject.gmLabels.push (label)
              })

            }

            mailObject.save (function (err) {
              if (err) {
                winston.doError ('Could not save mail object', err)
              }
            })
            
            currentLength += 1

            console.log (currentLength)
          });     

        });
      }
    }, function(err) {

      if (err) { 
        callback (err) 
      }
      else {
        callback (null, uidRange)
      }

    }
  );

}



exports.getMessagesWithAttachments = function (imapConn, since, userId, callback) {

  // get a batch

  imapRetrieve.imapGetBySearch (imapConn, [ ['X-GM-RAW', 'has:attachment'], ['SINCE', since]], userId, function (err) {
    if (err) closeConnection(err); //TODO: change this

    console.log ('getMessagesWithAttachments done')
    callback (err)
  })
}

exports.getAllMessages = function (imapConn, since, userId, callback) {

}

/*
exports.createMailObjectsInBulk = function (objects, callback) {
  Mail.collection.insert(objects, function (err) {
    if (err) {
      callback (err)
    }
    else {
      callback (null)
    }
  })
}
*/
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

