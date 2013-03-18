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
        connTimeout: 30000
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
      console.log ('successfully opened mailbox! huzzah!', imap);
      imap.openBox('[Gmail]/All Mail', true, cb);
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