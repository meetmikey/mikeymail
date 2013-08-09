var serverCommon = process.env.SERVER_COMMON;
var utils = require(serverCommon + '/lib/utils');

function define(name, value) {
  Object.defineProperty(exports, name, {
    value : value,
    enumerable: true
  });
}

var environment = process.env.NODE_ENV;
var cloudEnvironment = 'azure';

if(environment === 'production') {
  define('ENV', 'production');
}
else if(environment === 'development') {
  define('ENV', 'development');
}
else{
  define('ENV', 'local');
}

// use azure for raw email
define ('USE_AZURE', true);

define('MY_NODE_ID', utils.getUniqueId());

define('TEMP_FILES_DIR', '/tmp');
define('INDEX_NAME', 'document_index');

// how many of each job to do per node
define('MAX_DOWNLOAD_JOBS', 3);
define('MAX_UPDATE_JOBS', 20);
define('MAX_RESUME_DOWNLOAD_JOBS', 2);


// polling intervals
define('MONGO_ACTIVE_CONNECTIONS_POLL_INTERVAL', 60*1000*2);
define('MONGO_OFFLINE_UPDATE_POLL_INTERVAL', 60*1000*60);
define('MONGO_RESUME_DOWNLOAD_POLL_INTERVAL', 60*1000*1);


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

define ('DONT_QUEUE_LOCALHOST', false);

define('HEADER_BATCH_SIZE', 1000);

var gigabyte = 1073741824;

define ('MAX_BANDWITH_TOTAL', gigabyte * 1.5);

define ('EMAIL_FETCH_BATCH_SIZE', 50);

define ('RESUME_BATCH_SIZE', 1000);

define('AWS_RAW_MSG_DIR', '/rawEmail');

define('ACCESS_TOKEN_UPDATE_TIME_BUFFER', 600000);

define('MARKETING_TEXT', '("opt-out" OR unsubscribe OR "viewing the newsletter" OR enews OR "edit your preferences" OR smartunsubscribe OR secureunsubscribe OR yahoogroups OR "manage your account" OR "group-digests")');

define('MARKETING_FROM', 'from:(notify@ OR notification@ OR notifications@ OR mailer-daemon@ OR @proxyvote.com OR bounces@ OR bounce@ OR pinbot@ OR reservation@ OR booking@ OR bookings@ OR newsletter@ OR elert@ OR do-not-reply@ OR notifier@ OR nagios@ OR noreply@ OR no-reply@ OR @facebookmail.com OR auto-confirm@ OR support@ OR service@ OR contact@ OR info@ OR member@ OR confirmation@ OR paypal@ OR edelivery@ OR marketing@ OR reply@ OR reservations@ OR sv@aerofs.com OR sp@aerofs.com OR www-data@web)');

define('ERROR_TYPE_ALL_MAIL_DOESNT_EXIST', 'ALL_MAIL_DOESNT_EXIST_ERR')
define('ERROR_TYPE_NO_BOX_TO_OPEN', 'NO_MAILBOX_TO_OPEN')

// 3 days if we try every 15 minutes after sending all mail error
define('MAX_ALLMAIL_ONBOARDING_ATTEMPTS', 1080);

// 15 mins in secs
define('ALLMAIL_ERROR_REQUEUE_DELAY', 900);
