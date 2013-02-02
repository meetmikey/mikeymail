var constants = require ('./constants'),
    imapConnect = require ('./lib/imapConnect'),
    imapRetrieve = require ('./lib/imapRetrieve'),
    knox = require (constants.SERVER_COMMON + '/lib/s3Utils').client,
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    http = require ('http'),
    https = require ('https'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston


winston.info("mikeymail daemon started")

sqsConnect.pollMailDownloadQueue(function (message, callback) {

  //TODO: get this info from the message
  var email = 'sagar@magicnotebook.com'
  var password = 'magic33notebook'
  var userId = 'myuser'


  // trigger downloading
  var connection = imapConnect.createImapConnection (email, password)
  imapConnect.openMailbox (connection, function (err) {
    winston.info ('connection opened for user: ' + email)

    imapRetrieve.getMessagesWithAttachments (connection, 'Jan 23, 2013', userId, function (err) {

      // TODO: delete message later
      callback (null)

    })

  })

}, constants.MAX_DOWNLOAD_JOBS)