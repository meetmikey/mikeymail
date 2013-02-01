var express = require('express'),
    sqsConnect = require('../serverCommon/lib/sqsConnect'),
    winston = require ('../serverCommon/lib/winstonWrapper').winston

var app = express()

// Config
app.configure(function () {
  app.set('port', 8080)
  app.use(express.bodyParser())  
  app.use(express.cookieParser())
  app.use(express.methodOverride())
  app.use(express.compress())
})

app.configure('localhost', function(){
  app.use(express.logger({ format:'\x1b[1m:method\x1b[0m \x1b[33m:url\x1b[0m :date \x1b[0m :response-time ms' }))
  app.use(express.errorHandler({ dumpExceptions: true, showStack: true }))
})


app.configure('development', function(){
  app.use(express.logger({ format:':method :url ---- :response-time ms ---- :date' }))
  app.use(express.errorHandler({ dumpExceptions: true, showStack: true }))  
})



app.configure('production', function(){
  app.use(express.logger({ format:':method :url ---- :response-time ms ---- :date' }))
  app.use(express.errorHandler({ dumpExceptions: true, showStack: false }))
})

// get the health of the server
app.get('/health', function (req, res) {
  res.send({
    pid: process.pid,
    memory: process.memoryUsage(),
    uptime: process.uptime()
  })
})

app.listen (app.get('port'), function () {
  winston.info("Express server listening on port " + app.get('port') + " in " + app.settings.env + " mode")
  sqsConnect.pollMailDownloadQueue(function (message, callback) {
    console.log (message)
    // after 5 seconds, handle message
    setTimeout (function () {
      console.log ('timeout call done')
      callback (null)
    }, 10000)
  }, 3)
})