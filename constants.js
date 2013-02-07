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

define('SERVER_COMMON', process.env.SERVER_COMMON)

define('MAX_DOWNLOAD_JOBS', 1)

define ('S3_RETRIES', 2)

var gigabyte = 1073741824

// .75 gb
define ('MAX_BANDWITH_ATTACHMENT', gigabyte * 3/4)

// extra .25 gb for other emails
define ('MAX_BANDWITH_TOTAL', gigabyte)

define('AWS_RAW_MSG_DIR', '/rawEmail')