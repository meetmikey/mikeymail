var constants = require ('./constants'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    mailDownloadDaemon = require ('./lib/mailDownloadDaemon'),
    mailListenDaemon = require ('./lib/mailListenDaemon'),
    mailResumeDownloadDaemon = require ('./lib/mailResumeDownloadDaemon'),
    mailUpdateDaemon = require ('./lib/mailUpdateDaemon');

// default
var modes = [];

// get the command line arguments - this will determine whether we 
// run in initial indexing mode or continuous update mode
process.argv.forEach(function (val, index, array) {
  var splitString = 'mode=';
  var modeIndex = val.indexOf(splitString);
  if (modeIndex > -1) {
    modes.push(val.substring(splitString.length, val.length));
  }
});

process.on('uncaughtException', function (err) {
  console.error (err);
  winston.doError('uncaughtException:', {err : err});
  process.exit(1)});

if (modes.length == 0) {
  modes = ['initial'];
}

winston.doInfo("mikeymail daemon started in modes: " + modes);

if (modes.indexOf('initial') != -1){
  mailDownloadDaemon.start();
}

if (modes.indexOf('update') != -1) {
  mailUpdateDaemon.start();
}

if (modes.indexOf('resume') != -1) {
  mailResumeDownloadDaemon.start();
}

if (modes.indexOf('listen') != -1) {
  mailListenDaemon.start();
}