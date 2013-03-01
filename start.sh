#!/bin/sh

#create the log dir if it isn't there already
LOG_DIR=/var/log/mikey/mikeymail
mkdir -p $LOG_DIR

# Invoke the Forever module (to START our Node.js server).
forever start -a -l $LOG_DIR/forever.log -o $LOG_DIR/out.log -e $LOG_DIR/err.log mikeymail.js mode=download mode=listen mode=resume