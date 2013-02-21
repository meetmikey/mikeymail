var constants = require ('../constants'),
    winston = require(constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose

var ActiveConnectionModel = mongoose.model ('ActiveConnection')
var mongoPoll = this;

exports.start = function (myUniqueId, callback) {
  // check every minute to see if we should drop any connections
  setInterval (function () {
    winston.info ('poll mongo')
    mongoPoll.pollConnections(myUniqueId, callback);
  }, constants.MONGO_POLL_INTERVAL);

}

exports.pollConnections = function (myUniqueId, callback) {
  ActiveConnectionModel.find({nodeId : myUniqueId}, 'userId', 
    function (err, foundConnections) {
      callback (err, foundConnections)
    })
}