var serverCommon = process.env.SERVER_COMMON;

var Imap = require('imap'),
    constants = require ('../constants'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston;


exports.createImapConnection = function (email, token) {

  var imapConnection = new Imap({
        user: email,
        xoauth2 : token,
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        connTimeout: 30000,
        debug : function (str) {
          console.log (str);
        }
      });

  return imapConnection;

}

exports.openMailbox = function (imap, cb) {

  imap.connect(function(err) {
    if (err) {
      console.error (imap);
      cb (winston.makeError (err));
    }
    else {
      // check whether they are "Google Mail" or "GMail"
      imap.getBoxes ('', function (getBoxesErr, boxes) {
        if (getBoxesErr) {
          cb(winston.makeError ('Could not get boxes', {err : getBoxesErr}));
        }
        else {
          var boxToOpen;
          var keys = Object.keys (boxes);

          // TODO: lookup mailbox in db
          keys.forEach (function (boxName) {
            if (boxName === '[Gmail]') {
              boxToOpen = boxName;
            }
            else if (boxName === '[Google Mail]') {
              boxToOpen = boxName;
            }
          });

          if (!boxToOpen) {
            cb (winston.makeError ('Could not find candidate mailbox to open', {boxes : boxes}));
            return;
          }

          // TODO: make sure ALL MAIL exists

          winston.doInfo ('Successfully connected to imap, now opening mailbox', {boxName : boxToOpen + '/All Mail'});
          imap.openBox(boxToOpen + '/All Mail', true, cb);
        }
      });
    }
    
  });

}

exports.closeMailbox = function (imap, cb) {
  imap.closeBox (cb);
}

exports.logout = function (imap, cb) {
  try {
    imap.logout (cb);
  } catch (err) {
    cb (err);
  }
}