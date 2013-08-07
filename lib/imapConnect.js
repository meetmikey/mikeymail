var serverCommon = process.env.SERVER_COMMON;

var Imap = require('imap'),
    mikeymailConstants = require('../constants'),
    util = require ('util'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston;


exports.createImapConnection = function (email, token) {

  var imapConnection = new Imap({
        user: email,
        xoauth2 : token,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 60000
      });

  return imapConnection;

};

exports.openMailbox = function (imap, userEmail, cb) {

  var callbackCalled = false;

  imap.connect();

  imap.once('ready', function (err) {
    if (err) {
      var winstonError = winston.makeError ('imap connect error', {err : err, email : userEmail});      
      if (err && err.level) {
        winston.setErrorType( winstonError,  err.level);
      } else if (err && err.source) {
        winston.setErrorType (winstonError, err.source);
      }

      if (err.source == 'timeout') {
        winstonError.extra.suppressError == true;
        winston.doWarn ('imap connect error timeout', {err : err, email : userEmail});
      }

      cb (winstonError);
      callbackCalled = true;
    }
    else {
      // check whether they are "Google Mail" or "GMail"
      imap.getBoxes ('', function (getBoxesErr, boxes) {

        if (getBoxesErr) {
          cb(winston.makeError ('Could not get boxes', {err : getBoxesErr}));
          callbackCalled = true;
        }
        else if (boxes) {
          var boxToOpen;
          var keys = Object.keys (boxes);

          keys.forEach (function (boxName) {
            if (boxName === '[Gmail]') {
              boxToOpen = boxName;
            }
            else if (boxName === '[Google Mail]') {
              boxToOpen = boxName;
            }
          });

          if (!boxToOpen) {
            var inspectedInfo = util.inspect (boxes, false, Infinity);
            var winstonError = winston.makeError ('Could not find candidate mailbox to open', {boxes : boxes, inspectedInfo: inspectedInfo});
            winston.setErrorType( winstonError, mikeymailConstants.ERROR_TYPE_NO_BOX_TO_OPEN );            
            cb (winstonError);
            callbackCalled = true;
            return;
          }


          var folderNames = {};

          // iterate through children of [Gmail] or [Google Mail] to get the ALLMAIL attribute
          var children = boxes[boxToOpen].children;
          var allMailEquivalent;

          if (children){
            for (var key in children) {
              children[key].attribs.forEach (function (attrib) {
                // TODO: remove backwards compatibility
                if (attrib === "ALLMAIL" || attrib === "\\All") {
                  allMailEquivalent = key;
                }

                folderNames [attrib] = key;
              });
            }
          }

          if (!allMailEquivalent) {
            var winstonError = winston.makeError ('Error: Could not find ALLMAIL folder', {folderNames : folderNames});
            winston.setErrorType( winstonError, mikeymailConstants.ERROR_TYPE_ALL_MAIL_DOESNT_EXIST );
            cb( winstonError );
            callbackCalled = true;
            return;
          }

          winston.doInfo ('Successfully connected to imap, now opening mailbox', {boxName : boxToOpen + '/All Mail'});
          imap.openBox(boxToOpen + '/' + allMailEquivalent, true, function (openBoxErr, mailbox) {
            // add dictionary of relevant folders to the mailbox
            if (openBoxErr) {
              cb (winston.makeError ('Could not open mailbox', {err : openBoxErr}));
              callbackCalled = true;
            }
            else {
              mailbox.folderNames = folderNames;
              cb (null, mailbox);              
              callbackCalled = true;
            }
          });
        }
        else {
          cb (winston.makeError ('No mailboxes found'));
          callbackCalled = true;
        }
      });
    }
    
  });

  imap.once('error', function(err) {
    if (callbackCalled) {
      winston.doWarn ('imap open boxes callback already called!', {err : err});
    } else {
      var winstonError = winston.makeError ('imap connect error', {err : err, email : userEmail});
      if (err && err.level) {
        winston.setErrorType( winstonError,  err.level);
      } else if (err && err.source) {
        winston.setErrorType (winstonError, err.source);
      }

      if (err.source == 'timeout') {
        winstonError.extra.suppressError == true;
        winston.doWarn ('imap connect error timeout', {err : err, email : userEmail});
      }

      cb (winstonError);
      callbackCalled = true;
    }
  });

  imap.once('end', function() {
    winston.doInfo('Connection ended');
  });

  imap.on('alert', function(msg) {
    winston.doWarn('Imap alert', {msg : msg, email : userEmail});
  });

};

exports.closeMailbox = function (imap, cb) {
  imap.closeBox (cb);
};

exports.logout = function (imap, cb) {
  try {
    imap.logout (cb);
  } catch (err) {
    cb (err);
  }
};
