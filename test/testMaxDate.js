var serverCommon = process.env.SERVER_COMMON;
var mongoPoll = require ('../lib/mongoPoll')
  , appInitUtils = require(serverCommon + '/lib/appInitUtils')
  , winston = require(serverCommon + '/lib/winstonWrapper').winston
  , MailModel = require (serverCommon + '/schema/mail').MailModel;


var initActions = [
  appInitUtils.CONNECT_MONGO
];

appInitUtils.initApp( 'testMaxDate', initActions, null, function() {

  /*
  MailModel.findOne ({userId : "51dc7a2146f7c1aa27000009", mmDone : {$exists : false}})
    .sort ('-gmDate')
    .limit (1)
    .exec (function (err, maxMail) {
      if (err) {
        console.error (err)
      } else if (!maxMail) {
        console.log ('no max mail')
      } else {
        console.log (maxMail.gmDate)
        console.log (maxMail.gmDate.getTime())
      }
    });
      */

  MailModel.find ({userId : "51dc7a2146f7c1aa27000009", mmDone : {$exists : false}})
    .where ('gmDate').lte (1373314460000)
    .where ('gmDate').gte (1365630250659)
    .limit (50)
    .exec (function(err, mail) {
      console.log (mail)
    })
})

