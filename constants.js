var conf = require('./conf')

function define(name, value) {
  Object.defineProperty(exports, name, {
    value : value,
    enumerable: true
  });
}

var environment = process.env.NODE_ENV

if(environment === 'production') {
  define('ENV', 'production')
}
else if(environment === 'development') {
  define('ENV', 'development')
}
else{
  define('ENV', 'localhost')
}

define('TEMP_FILES_DIR', '/tmp')
define('INDEX_NAME', 'document_index')

define('MAX_DOWNLOAD_JOBS', 5)
define('THROTTLE_RATE', )