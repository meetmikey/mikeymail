var Imap = require('imap'),
    inspect = require('util').inspect,
    constants = require ('../constants'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    fs = require('fs');


exports.createImapConnection = function (email, password) {

  var imapConnection = new Imap({
        user: email,
        password: password,
        host: 'imap.gmail.com',
        port: 993,
        secure: true
      });

  return imapConnection

}

exports.openMailbox = function (imap, cb) {

  imap.connect(function(err) {
    if (err) {
      imap.logout(function (err) {
        console.log ('could not log out')
      })

      cb (err)
    }
    else {
      imap.openBox('[Gmail]/All Mail', true, cb);
    }
  });

}