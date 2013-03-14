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

    var userInfo = {"__v":0,"_id":"51286e73c99dfd9f11000004","accessToken":"ya29.AHES6ZR1o0jSdi-0y2GcpYFXOaW4J71ES5UA3hI2BN_qk4RJ-rkstEY","displayName":"Sagar Mehta","email":"sagar@mikeyteam.com","expiresAt":"2013-02-25T01:39:50.082Z","firstName":"Sagar","googleID":"115882407960585095714","hostedDomain":"mikeyteam.com","lastName":"Mehta","locale":"en","refreshToken":"1/FnY2N0xlYd_1ca0p2ND5YrSCqWYk30lOBk0pltLulrA","timestamp":"2013-02-23T07:23:31.802Z","gmailScrapeRequested":true}

    var xoauth2gen = xoauth2.createXOAuth2Generator({
        user: userInfo.email,
        clientId: conf.google.appId,
        clientSecret: conf.google.appSecret,
        //accessToken : userInfo.accessToken,
        refreshToken: userInfo.refreshToken
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
            daemonUtils.setDeletedMessages
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
