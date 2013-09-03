var serverCommon = process.env.SERVER_COMMON;

var Imap = require('imap'),
    mikeymailConstants = require('../constants'),
    util = require ('util'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston;


exports.createImapConnection = function (email, token) {

  var imapParams = {
    user: email,
    xoauth2 : token,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 60000
  };

  if (mikeymailConstants.IMAP_DEBUG) {
    imapParams['debug'] = function (str) {
      console.log (str);
    }
  }

  var imapConnection = new Imap(imapParams);

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
          var hasGmail = false;
          var hasGoogleMail = false;

          keys.forEach (function (boxName) {
            if (boxName === '[Gmail]') {
              if (boxes[boxName].children) {
                boxToOpen = boxName;
                hasGmail = true;
              }
            }
            else if (boxName === '[Google Mail]') {
              if (boxes[boxName].children) {
                boxToOpen = boxName;
                hasGoogleMail = true;
              }
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
          var allMailEquivalent;

          // corner case - both Gmail and Google Mail folders are present
          if (hasGmail && hasGoogleMail) {
            var childrenGmail = boxes['[Gmail]'].children;

            for (var key in childrenGmail) {
              childrenGmail[key].attribs.forEach (function (attrib) {
                if (attrib === "ALLMAIL" || attrib === "\\All") {
                  allMailEquivalent = key;
                  boxToOpen = '[Gmail]';
                }
                folderNames [attrib] = key;
              });
            }

            var childrenGoogleMail = boxes['[Google Mail]'].children;

            for (var key in childrenGoogleMail) {
              childrenGoogleMail[key].attribs.forEach (function (attrib) {
                if (attrib === "ALLMAIL" || attrib === "\\All") {
                  allMailEquivalent = key;
                  boxToOpen = '[Google Mail]';
                }
                folderNames [attrib] = key;
              });
            }
          } else {
            var children = boxes[boxToOpen].children;

            if (children){
              for (var key in children) {
                children[key].attribs.forEach (function (attrib) {
                  if (attrib === "ALLMAIL" || attrib === "\\All") {
                    allMailEquivalent = key;
                  }

                  folderNames [attrib] = key;
                });
              }
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
      var winstonError = winston.makeError ('imap open boxes callback already called!', {err : err, email : userEmail});
      winstonError.extra.suppressError == true;
      winston.setErrorType (winstonError, err.code);
      cb (winstonError);
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
    winston.doInfo('Connection ended for user', {email : userEmail});
  });

  imap.on('alert', function(msg) {
    winston.doWarn('Imap alert', {msg : msg, email : userEmail});
  });

};

exports.closeMailbox = function (imap, cb) {
  imap.closeBox (cb);
};

exports.logout = function (imap, cb) {
  winston.doInfo ('logging out');
  imap.end();
  cb();
};