var express = require('express'),
    sqsConnect = require('./lib/sqsConnect')


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
  console.log("Express server listening on port %d in %s mode", app.get('port'), app.settings.env)
  sqsConnect.startPollingForDownloadJobs()
})