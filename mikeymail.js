var serverCommon = process.env.SERVER_COMMON;

var mikeyMailConstants = require ('./constants'),
    appInitUtils = require(serverCommon + '/lib/appInitUtils'),
    winston = require(serverCommon + '/lib/winstonWrapper').winston,
    serverCommonConf = require (serverCommon + '/conf'),
    mailDownloadDaemon = require ('./lib/mailDownloadDaemon'),
    mailListenDaemon = require ('./lib/mailListenDaemon'),
    mailResumeDownloadDaemon = require ('./lib/mailResumeDownloadDaemon');

var initActions = [
    appInitUtils.CONNECT_MONGO
  //, appInitUtils.MEMWATCH_MONITOR
];

serverCommonConf.turnDebugModeOn();

//initApp() will not callback an error.
//If something fails, it will just exit the process.
appInitUtils.initApp( 'mikeymail', initActions, serverCommonConf, function() {

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

  if (modes.length == 0) {
    modes = ['download'];
  }

  winston.doInfo('START: mikeymail daemon started in modes: ' + modes, {}, true);
  winston.doInfo('myUniqueId', {myUniqueId: mikeyMailConstants.MY_NODE_ID}, true);

  if (modes.indexOf('download') != -1){
    mailDownloadDaemon.start();
  }

  if (modes.indexOf('resume') != -1) {
    mailResumeDownloadDaemon.start();
  }

  if (modes.indexOf('listen') != -1) {
    mailListenDaemon.start();
  }

});
