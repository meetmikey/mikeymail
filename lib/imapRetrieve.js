var Imap = require('imap'),
    inspect = require('util').inspect,
    constants = require ('../constants'),
    conf = require (constants.SERVER_COMMON + '/conf'),
    fs = require('fs'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    knoxClient = require (constants.SERVER_COMMON + '/lib/s3Utils').client;

var MailModel = mongoose.model ('Mail')
var imapRetrieve = this;

exports.imapGetBySearch = function (imapConn, criteria, userId, getAllMessagesCallback) {

  var bandwithUsed = 0

  fs.mkdir (constants.TEMP_FILES_DIR + '/' + userId, function (err) {

    //TODO : check if dir exists?
    if (err) {
      winston.error ("Error: could not make directory", constants.TEMP_FILES_DIR + '/' + userId)
    }

    var awsDirectory = constants.AWS_RAW_MSG_DIR + '/attachments/' + userId

    console.log ('criteria', criteria)

    imapConn.search(criteria, function(err, results) {
      if (err) {
        callback (err)
      }
      else {

        console.log (results)
        if (results.length === 0) {
          return getAllMessagesCallback (null, results)
        }

        imapConn.fetch(results,
          { headers: false,
            size : true,
            body: true,
            cb: function(fetch) {
              fetch.on('message', function(msg) {
                
                var filename = constants.TEMP_FILES_DIR + '/' + userId + '/msg-' + msg.seqno + '-body.txt'
                console.log ('saving file', filename)

                fileStream = fs.createWriteStream(filename);
                
                msg.on('data', function(chunk) {
                  fileStream.write(chunk);
                });
                
                msg.on('end', function() {
                  bandwithUsed += msg.size
                  fileStream.end();
                })

                fileStream.on('close' , function () {

                  //TODO : redundant? something weird going on with undefined msg.seqno
                  var filename = constants.TEMP_FILES_DIR + '/' + userId + '/msg-' + msg.seqno + '-body.txt'

                  var headers = {
                    'Content-Type': 'text/plain'
                    , 'x-amz-server-side-encryption' : 'AES256'
                  };

                  var awsPath = awsDirectory + '/' + msg.uid + '-body.txt'

                  uploadFileToS3 (filename, awsPath, headers, userId, msg.uid, 0)

                });

              });
            }
          }, function(err) {

            if (err) {
              callback (err)
            }
            else {
              winston.info ('all done getting attachments')
              getAllMessagesCallback (null, bandwithUsed)            
            }

          });
        }
      });
  })

}

// local helper function
function uploadFileToS3 (filename, awsPath, headers, userId, uid, attempts) {

  knoxClient.putFile(filename, awsPath, headers, 
    function(err, res){
      
      if (err) {

        winston.doError ('error uploading file', err)
        winston.error ('filename:', filename)
        winston.error ('aws path:', awsPath)

        retry()
      }
      else{

        if (res.statusCode !== 200) {
          winston.doError ('Error: non 200 status code', res.statusCode)
          winston.error ('filename:', filename)
          winston.error ('aws path:', awsPath)

          retry()
        }
        else {

          var query = {'uid': uid, 'userId' : userId}

          // update mail table
          MailModel.findOneAndUpdate (query, 
            {$set : {s3Path : awsPath}}, 
            function (err, updatedMailRecord) {

              if (err) {
                winston.doError ('could not update model s3Path', err)
              }
              else if (!updatedMailRecord) {
                winston.doError ('zero records affected in update of record', query)
              }
              else {
                sqsConnect.addMessageToMailReaderQueue ({'userId' : userId, 'path' : awsPath, '_id' : updatedMailRecord._id})                
              }

            })
          
        }

      }
  
  })


  function retry () {
    // retry
    if (attempts < constants.S3_RETRIES) {
      uploadFileToS3 (filename, awsPath, headers, userId, uid, attempts + 1)
    }
    else {
      winston.error ('Max upload attempts exceeded for file', filename)
    }
  }

}


exports.getHeaders = function (imapConn, userId, mailboxId, maxUid, callback) {
  
  // TODO: see if we need to insert x records at a time 
  // var maxRecords = constants.OBJECTS_PER_MAIL_INSERT
  console.log ('getHeaders')

  var currentLength = 0

  uidRange = '1:' + maxUid
  console.log (uidRange)

  imapConn.fetch(uidRange,
    {size : true}, 
    { headers: ['message-id'],
      cb: function(fetch) {

        console.log (fetch)

        fetch.on('message', function(msg) {

          console.log ('msg', msg)

          var mailObject = new MailModel ({
            'userId' : userId,
            'mailboxId' : mailboxId
          })

          msg.on('headers', function(hdrs) {
            mailObject ['messageId'] = hdrs['message-id']
          });

          msg.on('end', function() {

            console.log ('msg', msg)

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

            if (msg.size) {
              mailObject.size = msg.size
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
        callback (null)
      }

    }
  );

}



exports.getMessagesWithAttachments = function (imapConn, userId, maxUid, totalBandwith, callback) {

  uidRange = '1:' + maxUid

  console.log ('getMessagesWithAttachments', uidRange)

  //TODO: batch this
  // get all attachments
  imapRetrieve.imapGetBySearch (imapConn, 
    [ ['X-GM-RAW', 'has:attachment'], ['UID', uidRange]], 
    userId, 
    function (err, bandwithUsed) {
    if (err) {
      callback (err)
    }
    else {
      console.log ('getMessagesWithAttachments done')
      callback (null, bandwithUsed)      
    }
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

