exports.checkLabelIsInvalid = function (mailObject, folderNames) {  
  var isInvalid = false;

  var skipLabels = [];

  if (!folderNames) {
    winston.doError ('Folder names have not been extracted!');
    return isInvalid;
  }

  if (folderNames['TRASH']) {
    var name = folderNames['TRASH'].toLowerCase();
    skipLabels.push (name);
    skipLabels.push (name.substring (0, name.length-1));
  }
  
  if (folderNames['DRAFTS']) {
    var name = folderNames['DRAFTS'].toLowerCase();
    skipLabels.push (name);
    skipLabels.push (name.substring (0, name.length-1));
  }

  if (folderNames ['SPAM']) {
    var name = folderNames['SPAM'].toLowerCase();
    skipLabels.push (name);
    skipLabels.push (name.substring (0, name.length-1));  
  }

  // sanity check
  if (skipLabels.length == 0) {
    winston.doWarn ('checkLabelIsInvalid - skipLabels has no length');
    return isInvalid;
  }

  if (mailObject.gmLabels && mailObject.gmLabels.length) {

    mailObject.gmLabels.forEach (function (label) {

      if (typeof label == "string") {
        // remove trailing and forward slashes
        var labelStripped = label.replace(/\/+$/, "").replace(/\\+$/, "").replace (/^\/+/, "").replace (/^\\+/, "").toLowerCase();

        // check if it's a draft or trash or spam
        if (skipLabels.indexOf (labelStripped) != -1) {
          isInvalid = true;
        }
      }

    });
  }

  return isInvalid;
}

var mailObject = {
  gmLabels : [ '///Drafts']
}

var test = exports.checkLabelIsInvalid (mailObject, {'DRAFTS' : 'Drafts'})
winston.doInfo('test', {test: test});