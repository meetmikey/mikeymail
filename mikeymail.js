var constants = require ('./constants'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    memwatch = require('memwatch'),
    mailDownloadDaemon = require ('./lib/mailDownloadDaemon'),
    mailListenDaemon = require ('./lib/mailListenDaemon'),
    mailResumeDownloadDaemon = require ('./lib/mailResumeDownloadDaemon'),
    mailUpdateDaemon = require ('./lib/mailUpdateDaemon');

// default
var modes = [];

if (process.env.NODE_ENV == 'localhost' || process.env.NODE_ENV == 'development') {
  var hd = new memwatch.HeapDiff();

  memwatch.on('leak', function(info) {
    winston.doError ('LEAK REPORT', {info : info});
  });

  memwatch.on('stats', function(stats) { 
    winston.doInfo ('STATS REPORT', {stats : stats});
    var diff = hd.end();

    winston.doInfo ('HEAP DIFF', {diff :diff});
    hd = new memwatch.HeapDiff();
  });

}

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
  winston.doError('uncaughtException:', {stack : err.stack, message : err.message});
  process.exit(1);
});

if (modes.length == 0) {
  modes = ['download'];
}

winston.doInfo("mikeymail daemon started in modes: " + modes);

if (modes.indexOf('download') != -1){
  mailDownloadDaemon.start();
}

if (modes.indexOf('update') != -1) {
  //mailUpdateDaemon.start();
}

if (modes.indexOf('resume') != -1) {
  mailResumeDownloadDaemon.start();
}

if (modes.indexOf('listen') != -1) {
  mailListenDaemon.start();
}