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
        secure: true,
        connTimeout: 60000
      });

  return imapConnection;

};

exports.openMailbox = function (imap, cb) {

  imap.connect(function(err) {
    if (err) {
      var winstonError = winston.makeError ('imap connect error', {err : err});      
      if (err && err.level) {
        winston.setErrorType( winstonError,  err.level);
      }
      cb (winstonError);
    }
    else {
      // check whether they are "Google Mail" or "GMail"
      imap.getBoxes ('', function (getBoxesErr, boxes) {

        if (getBoxesErr) {
          cb(winston.makeError ('Could not get boxes', {err : getBoxesErr}));
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

          console.log (boxes)

          if (!boxToOpen) {
            var inspectedInfo = util.inspect (boxes, false, Infinity);
            var winstonError = winston.makeError ('Could not find candidate mailbox to open', {boxes : boxes, inspectedInfo: inspectedInfo});
            winston.setErrorType( winstonError, mikeymailConstants.ERROR_TYPE_NO_BOX_TO_OPEN );            
            cb (winstonError);
            return;
          }


          var folderNames = {};

          // iterate through children of [Gmail] or [Google Mail] to get the ALLMAIL attribute
          var children = boxes[boxToOpen].children;
          var allMailEquivalent;

          if (children){
            for (var key in children) {
              children[key].attribs.forEach (function (attrib) {
                if (attrib === "ALLMAIL") {
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
            return;
          }

          winston.doInfo ('Successfully connected to imap, now opening mailbox', {boxName : boxToOpen + '/All Mail'});
          imap.openBox(boxToOpen + '/' + allMailEquivalent, true, function (openBoxErr, mailbox) {
            // add dictionary of relevant folders to the mailbox
            if (openBoxErr) {
              cb (winston.makeError ('Could not open mailbox', {err : openBoxErr}));
            }
            else {
              mailbox.folderNames = folderNames;
              cb (null, mailbox);              
            }
          });
        }
        else {
          cb (winston.makeError ('No mailboxes found'));
        }
      });
    }
    
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
