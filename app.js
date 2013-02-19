var constants = require ('./constants'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    mailDownloadDaemon = require ('./lib/mailDownloadDaemon'),
    mailUpdateDaemon = require ('./lib/mailUpdateDaemon');

winston.logToFiles('mikeymail');

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

winston.doInfo("mikeymail daemon started in mode:" + mode)


if (mode == 'initial') {
  mailDownloadDaemon.start()
}
else if (mode == 'continuous') {
  mailUpdateDaemon.start()
}