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

define ('S3_RETRIES', 4)

if (process.env.USE_MONGOHQ == 'true') {
  define ('USE_MONGO_HQ', true)
}
else {
  define ('USE_MONGO_HQ', false)
}

var gigabyte = 1073741824

// .8 gb
define ('MAX_BANDWITH_ATTACHMENT', gigabyte * 4/5)

// extra .2 gb for other emails
define ('MAX_BANDWITH_TOTAL', gigabyte)

define ('EMAIL_FETCH_BATCH_SIZE', 100)

define('AWS_RAW_MSG_DIR', '/rawEmail')


define('MARKETING_TEXT', '("opt-out" OR unsubscribe OR "viewing the newsletter" OR "privacy policy" OR enews OR "edit your preferences" OR "email notifications" OR "update profile" OR smartunsubscribe OR secureunsubscribe OR yahoogroups OR "manage your account" OR "group-digests" OR zenpayroll OR facebook OR asana)')

define('MARKETING_FROM', 'from:(noreply OR no-reply OR amazon.com OR linkedin.com OR facebookmail.com OR auto-confirm OR pinterest OR support OR service OR digest OR contact@ OR info@ OR twitter OR member OR confirmation OR @paypal.com OR edelivery@ OR notifications@)')

// include inline images only from my contacts