#!/bin/bash

# A script to store mini techsupport file 

# ----------------------------------------------------------------------------
# NOTES
# ----------------------------------------------------------------------------
# command to call techsupport: /home/pi/firewalla/scripts/techsupport reset, which is the same as the techsupport when creating zendesk cases.
# there will be a script to do the entire stuff, and it will be called by the reset script and bluetooth code.
# * https://github.com/firewalla/firewalla/blob/99b29a3e524a57fd5f78d4596c3e05e46b0ac12a/scripts/system-reset-all-overlayfs-navy.sh
# * https://github.com/firewalla/firewalla/blob/99b29a3e524a57fd5f78d4596c3e05e46b0ac12a/scripts/system-reset-all-overlayfs.sh
# * bluetooth binary (firereset)
# create a folder under /data to store the log tar.gz file. /data/support
# the time to execute techsupport should be limited, need to figure out based on the real data.
# /data/support should only keep last 3 versions of support files. (assume most of people won't reset for more the 3 times)
# if /data partition free space is less than 200MB, skip storing the tech support file.
# if remote support tar.gz file is over than 50MB, skip storing the tech support file.


# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------
: ${FIREWALLA_HOME:='/home/pi/firewalla'}
: ${FIREWALLA_TMP:='/data/support/tmp'}
STORE_DIR=/data/support
BACKUP_COUNT=3
RUN_TIMEOUT=180
DISK_FREE_MIN=200000 #200MB in KB
SUPPORT_FILE_NAME='support.tar.gz'
SUPPORT_FILE_PATH=$FIREWALLA_TMP/$SUPPORT_FILE_NAME
SUPPORT_FILE_SIZE_MAX=50000000 # 50MB in Byte
CLEAN_SUPPORT_FLAG_FILE='/dev/shm/clean_support.touch'

# ----------------------------------------------------------------------------
# Functions
# ----------------------------------------------------------------------------

err() {
    echo "ERROR: $@" >&2
}

run_techsupport() {
    export FIREWALLA_TMP=$FIREWALLA_TMP
    timeout $RUN_TIMEOUT $FIREWALLA_HOME/scripts/techsupport reset
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

sudo mkdir -p $FIREWALLA_TMP
sudo chmod 1777 $FIREWALLA_TMP

if [[ -e $CLEAN_SUPPORT_FLAG_FILE ]]; then
    echo "Clean $STORE_DIR"
    sudo rm -rf $STORE_DIR
    exit $?
fi

sudo mkdir -p $STORE_DIR
sudo chown pi:pi $STORE_DIR

cd $STORE_DIR

# check disk space
disk_free=$(df -Pk . | tail -1 | awk '{print $4}')
test $disk_free -ge $DISK_FREE_MIN || {
    err "free disk space in $PWD is less than $DISK_FREE_MIN, skip storing"
    exit 1
}

run_techsupport || {
    err failed to run techsupport
    exit 1
}

test -e $SUPPORT_FILE_PATH || {
    err $SUPPORT_FILE_PATH NOT exist
    exit 1
}

# check file size
support_file_size=$(stat -c %s $SUPPORT_FILE_PATH)
test $support_file_size -le $SUPPORT_FILE_SIZE_MAX || {
    err "$SUPPORT_FILE_PATH size($support_file_size) is over limit($SUPPORT_FILE_SIZE_MAX), skip storing"
    exit 1
}

# rotate existing files if any
for i in $(seq $BACKUP_COUNT -1 2)
do
    let j=i-1
    test -e ${SUPPORT_FILE_NAME}.$j && mv -f ${SUPPORT_FILE_NAME}.{$j,$i} 
done
mv -f ${SUPPORT_FILE_NAME}{,.1}
mv -f $SUPPORT_FILE_PATH $SUPPORT_FILE_NAME

sudo rmdir $FIREWALLA_TMP

ls -l
echo "Tech support file stored successfully"

exit 0
