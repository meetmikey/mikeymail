var sqsConnect = require('../serverCommon/lib/sqsConnect'),
    imapConnect = require ('./lib/imapConnect'),
    imapRetrieve = require ('./lib/imapRetrieve'),
    constants = require ('./constants'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston

winston.info("mikeymail daemon started")

sqsConnect.pollMailDownloadQueue(function (message, callback) {

  var email = 'sagar@magicnotebook.com'
  var password = 'magic33notebook'

  // trigger downloading
  var connection = imapConnect.createImapConnection (email, password)
  imapConnect.openMailbox (connection, function (err) {
    winston.info ('connection opened for user: ' + email)

    imapRetrieve.getMessagesWithAttachments (connection, 'January 1st, 2013', function (err) {

    })

  })

}, constants.MAX_DOWNLOAD_JOBS)