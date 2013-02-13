var constants = require ('./constants'),
    imapConnect = require ('./lib/imapConnect'),
    imapRetrieve = require ('./lib/imapRetrieve'),
    knox = require (constants.SERVER_COMMON + '/lib/s3Utils').client,
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    http = require ('http'),
    https = require ('https'),
    fs = require ('fs'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    conf = require (constants.SERVER_COMMON + '/conf'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    async = require ('async'),
    xoauth2 = require("xoauth2"),
    mailDownloadDaemon = require ('./lib/mailDownloadDaemon'),
    mailUpdateDaemon = require ('./lib/mailUpdateDaemon'),
    xoauth2gen;

// default
var mode = 'initial'

// get the command line arguments - this will determine whether we 
// run in initial indexing mode or continuous update mode
process.argv.forEach(function (val, index, array) {
  var splitString = 'mode='
  var modeIndex = val.indexOf(splitString)
  if (modeIndex > -1) {
    mode = val.substring(splitString.length, val.length)
  }
});

winston.info("mikeymail daemon started in mode:" + mode)


if (mode == 'initial') {
  mailDownloadDaemon.start()
}
else if (mode == 'continuous') {
  mailUpdateDaemon.start()
}


