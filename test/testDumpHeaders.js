var constants = require ('../constants'),
    imapConnect = require ('../lib/imapConnect'),
    imapRetrieve = require ('../lib/imapRetrieve'),
    sqsConnect = require(constants.SERVER_COMMON + '/lib/sqsConnect'),
    fs = require ('fs'),
    mongoose = require (constants.SERVER_COMMON + '/lib/mongooseConnect').mongoose,
    conf = require (constants.SERVER_COMMON + '/conf'),
    winston = require (constants.SERVER_COMMON + '/lib/winstonWrapper').winston,
    async = require ('async'),
    xoauth2 = require("xoauth2"),
    daemonUtils = require ('../lib/daemonUtils');

    var userInfo = {
      "googleID" : "104927852848168139591",
      "accessToken" : "ya29.AHES6ZQlJrR7UpGffHxW2kE-LwJ5W5nMVm5qEQszkyYdv6Y",
      "displayName" : "Andrew Lockhart",
      "firstName" : "Andrew",
      "lastName" : "Lockhart",
      "email" : "andrewjameslockhart@gmail.com",
      "refreshToken" : "1/0T0Llhq_O8EevoSiMpf6japhdtHezut5jkwznfBXWVQ",
      "gender" : "male",
      "locale" : "en-GB",
      "picture" : "https://lh4.googleusercontent.com/-wHFwsh7hVno/AAAAAAAAAAI/AAAAAAAAB2A/uEEMG7RDlIg/photo.jpg",
      "expiresAt" : ISODate("2013-03-01T20:31:37.908Z"),
      "_id" : ObjectId("51310219ce9d82443e000006"),
      "timestamp" : ISODate("2013-03-01T19:31:37.910Z"),
      "gmailScrapeRequested" : true,
      "__v" : 0
    }

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

          winston.doInfo('Mailbox opened for user', {email: userInfo.email, mailbox: mailbox});

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
                  winston.doInfo('mailbox closed for user', {email: userInfo.email});
                }
              })

              winston.doInfo('Finished updating for user ', {email: userInfo.email})
            }

          })

          function startAsync (callback) {
            argDict.minUid = minUid
            argDict.maxUid = maxUid
            callback (null, argDict)
          }

        })
    })
