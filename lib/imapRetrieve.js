var Imap = require('imap'),
    inspect = require('util').inspect,
    constants = require ('../constants'),
    conf = require (constants.SERVER_COMMON + '/conf'),
    fs = require('fs'),
    mailUtils = require (constants.SERVER_COMMON + '/lib/mailUtils'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    uploadUtils = require ('./uploadUtils'),
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect');

var MailModel = mongoose.model ('Mail')
var imapRetrieve = this;

exports.imapSearch = function (imapConn, criteria, callback) {

  imapConn.search(criteria, function(err, results) {
    callback (err, results)
  })

}

exports.getHeaders = function (imapConn, userId, mailboxId, minUid, maxUid, callback) {
  // TODO: see if we need to insert x records at a time 
  // var maxRecords = constants.OBJECTS_PER_MAIL_INSERT
  winston.info ('getHeaders')

  var currentLength = 0;
  uidRange = minUid + ':' + maxUid;

  try {

    imapConn.fetch(uidRange,
      {size : true}, 
      { headers: ['message-id', 'from', 'to', 'cc', 'bcc'],
        cb: function(fetch) {

          fetch.on('message', function(msg) {
            
            var mailObject = new MailModel ({
              'userId' : userId,
              'mailboxId' : mailboxId
            })

            msg.on('headers', function(hdrs) {
              mailUtils.normalizeAddressArrays (hdrs)
              mailObject ['messageId'] = hdrs['message-id']
              mailObject ['sender'] = mailUtils.getSender (hdrs)
              mailObject ['recipients'] = mailUtils.getAllRecipients (hdrs)
            });

            msg.on('end', function() {

              mailObject ['uid'] = msg.uid
              mailObject ['seqNo'] = msg.seqno
              mailObject ['size'] = msg.size

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
                if (err && err.code == 11000) {
                  winston.doInfo ('Mail saved fail due to duplicate key', {uid : msg.uid, userId : userId})
                }
                else if (err) {
                  winston.doError ('Could not save mail object', err)
                }
              })
              
              currentLength += 1

            });     

          });
        }
      }, 
      function(err) {
        callback (err)
      });
    } catch (err) {
      winston.doError ('Caught error getHeaders', {err : err});
      callback (err);
    }
}


exports.getUpdates = function (imapConn, minUid, callback) {

  winston.info ('getUpdates')
  var msgIds = []

  var currentLength = 0
  uidRange = minUid + ':*'

  imapConn.fetch(uidRange,
    {size : false},
    { headers: false,
      cb: function(fetch) {

        fetch.on('message', function(msg) {
         
          msg.on('end', function() {
            console.log  (msg)
            msgIds.push  (msg.uid)
            currentLength += 1

          });   

        });
      }
    }, 
    function(err) {
      if (err) {
        callback (err);
      }
      else {
        callback (null, msgIds);
      }
    });

}





exports.getIdsOfMessagesWithAttachments = function (imapConn, minUid, maxUid, callback) {
  var uidRange = getUidRangeString(minUid, maxUid)

  imapConn.search([ ['X-GM-RAW', 'has:attachment'], ['UID', uidRange]], function(err, results) {
    callback (err, results)
  })

}

exports.getMessagesByUid = function (imapConn, userId, messages, isUpdate, getAllMessagesCallback) {

  var messageIds = messages.map (function (elem) { return elem.uid})

  if (messageIds.length === 0) {
    getAllMessagesCallback (null, 0)
  }
  else {
    imapRetrieve.fetchMsgBodies (imapConn, messageIds, userId, isUpdate, getAllMessagesCallback)
  }

}

exports.getMarketingTextIds = function (imapConn, minUid, maxUid, callback) {
  var uidRange = getUidRangeString(minUid, maxUid)

  imapConn.search([ ['X-GM-RAW', constants.MARKETING_TEXT], ['UID', uidRange]], function(err, results) {
    callback (err, results)
  })

}


exports.getMarketingFromIds = function (imapConn, minUid, maxUid, callback) {
  var uidRange = getUidRangeString(minUid, maxUid)

  imapConn.search([ ['X-GM-RAW', constants.MARKETING_FROM], ['UID', uidRange]], function(err, results) {
    callback (err, results)
  })

}

// accepts an array of uids and returns the bandwith used
exports.fetchMsgBodies = function (imapConn, uidArray, userId, isUpdate, getAllMessagesCallback) {

  var awsDirectory = constants.AWS_RAW_MSG_DIR + '/' + userId;
  var bandwithUsed = 0;

  imapConn.fetch(uidArray,
    {size : true},
    { body: true,
      headers: { parse: false },
      cb: function(fetch) {
        fetch.on('message', function(msg) {
          
          var filename = constants.TEMP_FILES_DIR + '/' + userId + '/msg-' + msg.seqno + '-ts-' +  + Date.now() + '-body.txt'

          fileStream = fs.createWriteStream(filename)

          msg.on('data', function(chunk) {
            fileStream.write(chunk)
          });
          
          msg.on('end', function() {
            bandwithUsed += msg.size
            fileStream.end()
          })

          fileStream.on('close' , function () {

            var headers = {
              'Content-Type': 'text/plain'
              , 'x-amz-server-side-encryption' : 'AES256'
            }

            var awsPath = awsDirectory + '/' + msg.uid + '-body.txt'

            uploadUtils.uploadFileToS3 (filename, awsPath, headers, userId, msg.uid, isUpdate, 0)

          })

        })
      }
    }, function(err) {

      if (err) {
        getAllMessagesCallback (err)
      }
      else {
        winston.info ('all done fetching msg bodies')
        getAllMessagesCallback (null, bandwithUsed)            
      }

    })

}


// local helper functions
function getUidRangeString (minUid, maxUid) {
  return minUid + ':'  + maxUid
}
