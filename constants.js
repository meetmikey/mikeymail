function define(name, value) {
  Object.defineProperty(exports, name, {
    value : value,
    enumerable: true
  });
}

var environment = process.env.NODE_ENV;

if(environment === 'production') {
  define('ENV', 'production');
}
else if(environment === 'development') {
  define('ENV', 'development');
}
else{
  define('ENV', 'localhost');
}

define('TEMP_FILES_DIR', '/tmp');
define('INDEX_NAME', 'document_index');

define('SERVER_COMMON', process.env.SERVER_COMMON);

define('MAX_UPDATE_JOBS', 100);

define('MAX_DOWNLOAD_JOBS', 10);

define('MAX_RESUME_DOWNLOAD_JOBS', 10);

define('MONGO_ACTIVE_CONNECTIONS_POLL_INTERVAL', 60*1000*3); // 3 minutes

define('MONGO_OFFLINE_UPDATE_POLL_INTERVAL', 60*1000*10); // 10 minutes

define('OFFLINE_UPDATE_INTERVAL', 60*1000*60); // 60 minutes

define('MONGO_RESUME_DOWNLOAD_POLL_INTERVAL', 60*1000*10); // 10 minutes

define('RESUME_DOWNLOAD_SET_INTERVAL', 60*1000*1); // 1 minute

define('LISTENING_TIMESTAMP_INTERVAL', 60*1000*1);

define('RESUME_DOWNLOAD_AFTER', 24*60*60*1000) // 24 hours

define ('S3_RETRIES', 4);

define ('DONT_QUEUE_LOCALHOST', false);

var gigabyte = 1073741824;

// .8 gb
define ('MAX_BANDWITH_ATTACHMENT', gigabyte * 4/5);

// extra .2 gb for other emails
define ('MAX_BANDWITH_TOTAL', gigabyte);

define ('EMAIL_FETCH_BATCH_SIZE', 100);

define('AWS_RAW_MSG_DIR', '/rawEmail');

// 10 mins
define('ACCESS_TOKEN_UPDATE_TIME_BUFFER', 600000);

define('MARKETING_TEXT', '("opt-out" OR unsubscribe OR "viewing the newsletter" OR "privacy policy" OR enews OR "edit your preferences" OR "email notifications" OR "update profile" OR smartunsubscribe OR secureunsubscribe OR yahoogroups OR "manage your account" OR "group-digests")');

define('MARKETING_FROM', 'from:(noreply OR no-reply OR amazon.com OR linkedin.com OR facebookmail.com OR auto-confirm OR pinterest.com OR support OR service OR digest OR contact@ OR info@ OR twitter OR member OR confirmation OR @paypal.com OR edelivery@ OR notifications@ OR marketing@ OR zenpayroll.com OR asana.com)');