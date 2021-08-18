#!/bin/bash


RETRY_INTERVAL=60
TIME_THRESHOLD="2021-05-20"

function sync_website() {
    time_website=$1
    logger "Syncing time from ${time_website}..."
    time=$(curl -ILsm5 ${time_website} | awk -F ": " '/^[Dd]ate: / {print $2}'|tail -1)
    if [[ "x$time" == "x" ]]; then
        logger "ERROR: Failed to load date info from website: $time_website"
        return 1
    else
        # compare website time against threshold to prevent it goes bad in some rare cases
        tsWebsite=$(date -d "$time" +%s)
        tsThreshold=$(date -d "$TIME_THRESHOLD" +%s)
        if [ $tsWebsite -ge $tsThreshold ];
        then
          echo "$tsWebsite";
          return 0
        else
          return 1
        fi
    fi
}

function sync_time() {
    tsWebsite=$(sync_website status.github.com || sync_website google.com || sync_website live.com || sync_website facebook.com)
    tsSystem=$(date +%s)
    if [ "0$tsWebsite" -ge "0$tsSystem" ]; # prefix 0 as tsWebsite could be empty
    then
        logger "Sync time to $tsWebsite($(date -d @$tsWebsite))"
        sudo date +%s -s "@$tsWebsite";
        return $?
    fi
    return 1
}

logger "FIREONBOOT.UPGRADE.DATE.SYNC"

while ! sync_time
do
    ${SYNC_ONCE:-false} && break
    logger "Sleeping for $RETRY_INTERVAL seconds before next try ..."
    sleep $RETRY_INTERVAL
done

logger "FIREONBOOT.UPGRADE.DATE.SYNC.DONE"
sync