var serverCommon = process.env.SERVER_COMMON;
var mongoPoll = require ('../lib/mongoPoll')
  , appInitUtils = require(serverCommon + '/lib/appInitUtils')
  , winston = require(serverCommon + '/lib/winstonWrapper').winston


var initActions = [
  appInitUtils.CONNECT_MONGO
];

appInitUtils.initApp( 'resumeDownload', initActions, null, function() {
  mongoPoll.pollForResumeDownload (function (err) {
    winston.doInfo('done');
  })
})

