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
        secure: true
      });

  return imapConnection;

}

exports.openMailbox = function (imap, cb) {

  imap.connect(function(err) {

    if (err) {
      cb (winston.makeError (err));
    }
    else {
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
    winston.doError ('Could not logout', {err : err});
    cb (err);
  }
}