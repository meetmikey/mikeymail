var serverCommon = process.env.SERVER_COMMON;

var constants = require ('../constants'),
    imapConnect = require ('../lib/imapConnect'),
    imapRetrieve = require ('../lib/imapRetrieve'),
    sqsConnect = require(serverCommon + '/lib/sqsConnect'),
    fs = require ('fs'),
    mongoose = require (serverCommon + '/lib/mongooseConnect').mongoose,
    conf = require (serverCommon + '/conf'),
    winston = require (serverCommon + '/lib/winstonWrapper').winston,
    async = require ('async'),
    xoauth2 = require("xoauth2"),
    daemonUtils = require ('../lib/daemonUtils');
//ObjectId("5119c7b60746d47552000005")

    var userInfo = {email : 'sagar@magicnotebook.com', _id : '5119c7b60746d47552000005'}

    var xoauth2gen = xoauth2.createXOAuth2Generator({
        user: userInfo.email,
        clientId: conf.google.appId,
        clientSecret: conf.google.appSecret,
        //accessToken : userInfo.accessToken,
        refreshToken: '1/foOYDyaQOkcgALX5KIMidX3REOScB0lr-yB-F5UzRdM'
    });

    var minUid = process.argv[2]
    var maxUid = process.argv[3]

    if (!minUid || !maxUid) {
      winston.doError ('Must specify minUid and maxUid when running test')
      process.exit(1)
    }

    xoauth2gen.getToken(function(err, token) {
        if(err){
          winston.doError('Error: could not generate xoauth token', err)
          return
        }
       
        // connect to imap server
        var myConnection = imapConnect.createImapConnection (userInfo.email, token)
        
        // open mailbox
        imapConnect.openMailbox (myConnection, function (err, mailbox) {

          if (err) {
            winston.doError ('Error: Could not open mailbox', err)
            return
          }

          winston.info ('Connection opened for user: ' + userInfo.email)
          winston.info ('Mailbox opened', mailbox)

          var operations = [
            startAsync,
           // daemonUtils.retrieveHeaders,
            daemonUtils.mapReduceContacts,
            daemonUtils.mapReduceReceiveCounts
          ]


          // all variables needed by async waterfall are passed in this object
          var argDict = {
            'userId' : userInfo._id,
            'userEmail' : userInfo.email,
            'isOnboarding' : false,
            'myConnection' : myConnection,
            'attachmentBandwith' : 0,
            'otherBandwith' : 0,
            'totalBandwith' : 0,
            'mailbox' : mailbox
          }



          async.waterfall (operations, function (err) {

            if (err) {
              winston.doError ('Could not finish updating', err)
            }
            else {
              // close the mailbox
              imapConnect.closeMailbox (myConnection, function (err) {
                if (err) {
                  winston.doError ('Could not close mailbox', err)
                }
                else {
                  winston.info ('mailbox closed for user ' + userInfo.email)
                }
              })

              winston.info ('Finished updating for user ' + userInfo.email)
            }

          })

          function startAsync (callback) {
            argDict.minUid = minUid
            argDict.maxUid = maxUid
            callback (null, argDict)
          }

        })
    })
