var serverCommon = process.env.SERVER_COMMON;

var imapRetrieve = require ('../lib/imapRetrieve')
  , conf = require (serverCommon + '/conf')
  , mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose
  , appInitUtils = require (serverCommon + '/lib/appInitUtils')
  , winston = require (serverCommon + '/lib/winstonWrapper').winston
  , ReceiveMRModel = require(serverCommon + '/schema/contact').ReceiveMRModel
  , SentAndCoReceiveMRModel = require(serverCommon + '/schema/contact').SentAndCoReceiveMRModel;

var mails = [{
		"_id" : "518840ed453b7c865f0006b7",
		"gmDate" : "2012-12-04T17:03:52Z",
		"gmLabels" : [
			"\\Inbox"
		],
		"gmMsgId" : "1420443656062351697",
		"gmThreadId" : "1420443656062351697",
		"hasMarketingFrom" : true,
		"mailboxId" : "518840e8453b7c865f00000a",
		"messageId" : [
			"<UCZWCZCW$UWYXZXTZWTZWZ@127.0.0.1>"
		],
		"recipients" : [
			{
				"name" : "Sagar Mehta",
				"email" : "sagar@magicnotebook.com"
			}
		],
		"sender" : {
			"name" : "obama",
			"email" : "barack@obama.com"
		},
		"seqNo" : 1708,
		"size" : 57054,
		"uid" : 1881,
		"userId" : "518840e7c267f56958000009"
	},
	{
		"_id" : "518840ee453b7c865f0007b5",
		"gmDate" : "2012-12-22T01:00:33Z",
		"gmLabels" : [
			"\\Inbox"
		],
		"gmMsgId" : "1422013794707394101",
		"gmThreadId" : "1422013794707394101",
		"hasMarketingText" : true,
		"mailboxId" : "518840e8453b7c865f00000a",
		"messageId" : [
			"<1261021657.65406@cloudera.com>"
		],
		"recipients" : [
			{
				"name" : "sagar@magicnotebook.com",
				"email" : "sagar@magicnotebook.com"
			},
      {
        "name" : "Jay",
        "email" : "j@mib.com"
      }

		],
		"sender" : {
			"name" : "The Cloudera Team",
			"email" : "updates@cloudera.com"
		},
		"seqNo" : 1961,
		"size" : 6478,
		"uid" : 2158,
		"userId" : "518840e7c267f56958000009"
	},
	{
		"_id" : "518840ee453b7c865f0007cb",
		"gmDate" : "2012-12-29T08:30:13Z",
		"gmLabels" : [
			"\\Inbox"
		],
		"gmMsgId" : 1422676264409514000,
		"gmThreadId" : 1422676264409514000,
		"hasMarketingFrom" : true,
		"mailboxId" : "518840e8453b7c865f00000a",
		"messageId" : [
			"<1356769807.50deaa0fa0a4c@swift.generated>"
		],
		"recipients" : [
			{
				"name" : "Sagar Mehta",
				"email" : "sagar@magicnotebook.com"
			}
		],
		"sender" : {
			"name" : "GrexIt Team",
			"email" : "support@grexit.com"
		},
		"seqNo" : 1983,
		"size" : 4179,
		"uid" : 2184,
		"userId" : "518840e7c267f56958000009"
	},
  {
    "_id" : "518840ee453b7c865f0007cb",
    "gmDate" : "2012-12-29T08:30:13Z",
    "gmLabels" : [
      "\\Inbox"
    ],
    "gmMsgId" : 1422676264409514000,
    "gmThreadId" : 1422676264409514000,
    "hasMarketingFrom" : true,
    "mailboxId" : "518840e8453b7c865f00000a",
    "messageId" : [
      "<1356769807.50deaa0fa0a4c@swift.generated>"
    ],
    "recipients" : [
      {
        "name" : "Jay",
        "email" : "j@mib.com"
      }
    ],
    "sender" : {
      "name" : "Boom",
      "email" : "sagar@magicnotebook.com"
    },
    "seqNo" : 1983,
    "size" : 4179,
    "uid" : 2184,
    "userId" : "518840e7c267f56958000009"
  },
  {
    "_id" : "518840ee453b7c865f0007cb",
    "gmDate" : "2012-12-29T08:30:13Z",
    "gmLabels" : [
      "\\Inbox"
    ],
    "gmMsgId" : 1422676264409514000,
    "gmThreadId" : 1422676264409514000,
    "hasMarketingFrom" : true,
    "mailboxId" : "518840e8453b7c865f00000a",
    "messageId" : [
      "<1356769807.50deaa0fa0a4c@swift.generated>"
    ],
    "recipients" : [
      {
        "name" : "Jay",
        "email" : "j@mib.com"
      },
      {
        "name" : "Kay",
        "email" : "k@mib.com"
      }
    ],
    "sender" : {
      "name" : "Boom",
      "email" : "boomboom@magicnotebook.com"
    },
    "seqNo" : 1983,
    "size" : 4179,
    "uid" : 2184,
    "userId" : "518840e7c267f56958000009"
  }
]



var initActions = [
  appInitUtils.CONNECT_MONGO
];

appInitUtils.initApp( 'testMapReduceInMemory', initActions, conf, function() {
  var mrResults = imapRetrieve.mapReduceContactsInMemory ("518840e7c267f56958000009", "sagar@magicnotebook.com", mails);

  for (key in mrResults.sentDict) {
    var keyObj = {
      _id: {
          userId:  "518840e7c267f56958000009"
        , email: key
      }
    };

    var increment =  mrResults.sentDict[key];

    SentAndCoReceiveMRModel.collection.update (keyObj, {$inc : {"value.sent" : increment}}, {upsert : true}, function (err, num) {
      if (err) {
        winston.makeMongoError (err);
      } else {
        winston.doInfo ('increment map reduce record sent', {key : keyObj, value : increment})
      }
    });
  }

  for (key in mrResults.coReceiveDict) {
    var keyObj = {
      _id: {
          userId:  "518840e7c267f56958000009"
        , email: key
      }
    };

    var increment = mrResults.coReceiveDict[key];

    SentAndCoReceiveMRModel.collection.update (keyObj, {$inc : {"value.coreceive" : increment}}, {upsert : true}, function (err, num) {
      if (err) {
        winston.makeMongoError (err);
      } else {
        winston.doInfo ('increment map reduce record coreceive', {key : keyObj, value : increment})
      }
    });
  }

  for (key in mrResults.receiveDict) {
    var keyObj = {
      _id: {
          userId:  "518840e7c267f56958000009"
        , email: key
      }
    };
    var increment = mrResults.receiveDict[key];

    ReceiveMRModel.collection.update (keyObj, {$inc : {"value" : increment}}, {upsert : true}, function (err, num) {
      if (err) {
        winston.makeMongoError (err);
      } else {
        winston.doInfo ('increment map reduce record receive', {key : keyObj, value : increment})
      }
    });
  }

});


exports.mapReduceContactsInMemory = function (userId, userEmail, docsForContactCounts, callback) {
  var sentDict = {};
  var coReceiveDict = {};
  var receiveDict = {};

  docsForContactCounts.forEach (function (doc) {
    doc.recipients.forEach (function (recipient) {
      //var key = {email : recipient.email, userId : userId};
      var key = recipient.email;

      if (doc.sender.email == userEmail) {
        imapRetrieve.incrementDictForKey (key, sentDict);
      } else {
        imapRetrieve.incrementDictForKey (key, coReceiveDict);
      }
    });

    var senderKey = doc.sender.email;
    imapRetrieve.incrementDictForKey (senderKey, receiveDict);
  });

  var results = {
    sentDict : sentDict,
    coReceiveDict : coReceiveDict,
    receiveDict : receiveDict
  }

  return results;
}