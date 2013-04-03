var serverCommon = process.env.SERVER_COMMON;
var utils = require(serverCommon + '/lib/utils');

function define(name, value) {
  Object.defineProperty(exports, name, {
    value : value,
    enumerable: true
  });
}

var environment = process.env.NODE_ENV;
var cloudEnvironment = process.env.CLOUD_ENV;

if(environment === 'production') {
  define('ENV', 'production');
}
else if(environment === 'development') {
  define('ENV', 'development');
}
else{
  define('ENV', 'localhost');
}

define ('USE_AZURE', cloudEnvironment === 'azure');

define('MY_NODE_ID', utils.getUniqueId());

define('TEMP_FILES_DIR', '/tmp');
define('INDEX_NAME', 'document_index');

// how many of each job to do per node
define('MAX_DOWNLOAD_JOBS', 2);
define('MAX_UPDATE_JOBS', 20);
define('MAX_RESUME_DOWNLOAD_JOBS', 10);


// polling intervals
define('MONGO_ACTIVE_CONNECTIONS_POLL_INTERVAL', 60*1000*2);
define('MONGO_OFFLINE_UPDATE_POLL_INTERVAL', 60*1000*60);
define('MONGO_RESUME_DOWNLOAD_POLL_INTERVAL', 60*1000*2);


// intervals for how often we update mongo model to say current node is still working on x
define('RESUME_DOWNLOAD_TIMESTAMP_INTERVAL', 60*1000*1);
define('LISTENING_TIMESTAMP_UPDATE_INTERVAL', 60*1000*.5);
define('ONBOARDING_TIMESTAMP_UPDATE_INTERVAL', 60*1000*1);

// how long we wait above the factor of update interval to declare the node who claimed the job must be dead
// is this factor multiplied by the corresponding interval above. should be greater than 1.
define('ONBOARDING_TIMESTAMP_RECLAIM_FACTOR', 2.5);
define('RESUME_DOWNLOAD_TIMESTAMP_RECLAIM_FACTOR', 2.5);

// after we have a gig of data how long do we wait before resuming the account
define('RESUME_DOWNLOAD_AFTER', 24*60*60*1000); // 24 hours

define ('S3_RETRIES', 4);

define ('DONT_QUEUE_LOCALHOST', false);

define('HEADER_BATCH_SIZE', 1000);

define ('POLL_IMAP_HACK_TIME', 1000*60*10); // 10 mins

var gigabyte = 1073741824;

define ('MAX_BANDWITH_TOTAL', gigabyte);

define ('EMAIL_FETCH_BATCH_SIZE', 50);

define('AWS_RAW_MSG_DIR', '/rawEmail');

define('ACCESS_TOKEN_UPDATE_TIME_BUFFER', 600000);

define('MARKETING_TEXT', '("opt-out" OR unsubscribe OR "viewing the newsletter" OR "privacy policy" OR enews OR "edit your preferences" OR "email notifications" OR "update profile" OR smartunsubscribe OR secureunsubscribe OR yahoogroups OR "manage your account" OR "group-digests")');

define('MARKETING_FROM', 'from:(notifier OR nagios OR noreply OR no-reply OR amazon.com OR linkedin.com OR facebookmail.com OR auto-confirm OR pinterest.com OR support OR service OR digest OR contact@ OR info@ OR twitter OR member OR confirmation OR @paypal.com OR edelivery@ OR notifications@ OR marketing@ OR zenpayroll.com OR asana.com OR reservations@)');
