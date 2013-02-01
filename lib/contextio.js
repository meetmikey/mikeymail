  var ContextIO = require('contextio');
  
  var ctxioClient = new ContextIO.Client({
    key: "wxos1lck",
    secret: "oDNdOC3yojWwriEZ"
  });

/*
  ctxioClient.accounts().get({limit:15}, function (err, response) {
    if (err) throw err;
    console.log(response.body);
  });

  ctxioClient.accounts('51098b37f88c47ef56000001').messages().get({limit:100, include_body : 1}, function (err, response) {
    if (err) throw err;
    console.log(response.body);
  });

  */