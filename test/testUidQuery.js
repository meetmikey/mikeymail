var imapRetrieve = require ('../lib/imapRetrieve');

var minUid = 4;
var maxUid = 100;
var uidArray;
uidArray = [12,5,6,8]

console.log (imapRetrieve.getUidQuery (null, null, uidArray))

console.log (imapRetrieve.getUidQuery (minUid, maxUid, null))

console.log (imapRetrieve.getUidQuery ())

console.log (imapRetrieve.getUidQuery (null, null, []))