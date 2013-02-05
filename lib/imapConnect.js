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
        secure: true,
        debug : function (str) {
          console.log (str)
        }
      });

  return imapConnection

}

exports.openMailbox = function (imap, cb) {

  imap.connect(function(err) {

    console.log ('connection', imap)

    
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