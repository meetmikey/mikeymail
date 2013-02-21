var Imap = require('imap'),
    inspect = require('util').inspect,
    constants = require ('../constants'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    fs = require('fs');


exports.createImapConnection = function (email, token) {

  var imapConnection = new Imap({
        user: email,
        xoauth2 : token,
        host: 'imap.gmail.com',
        port: 993,
        secure: true
      });

  return imapConnection

}

exports.openMailbox = function (imap, cb) {

  imap.connect(function(err) {

    if (err) {
      //imap.logout(function (err) {
      //  winston.error ('could not log out')
      //})

      cb (err)
    }
    else {
      imap.openBox('[Gmail]/All Mail', true, cb);
    }
    
  });

}

exports.closeMailbox = function (imap, cb) {
  imap.closeBox (cb)
}

exports.logout = function (imap, cb) {
  try {
    imap.logout (cb)
  } catch (err) {
    winston.doError ('Could not logout', {err : err})
  }
}