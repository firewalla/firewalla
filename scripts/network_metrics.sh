#!/bin/bash

# ----------------------------------------------------------------------------
# Description
# ----------------------------------------------------------------------------

# Record transferred bytes in redis as raw data
# Calculate throughput of given period(15min) as sample data
# Get metrics of sample data including mean/75p/90p

CMD=$(basename $0)
: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${SAMPLE_DURATION:=10}      # sample throughput data average 10 seconds period
: ${SAMPLE_INTERVAL:=900}     # sample every 15 minutes
: ${CALC_INTERVAL:=900}       # calculate stats every 15 minutes
: ${EXPIRE_PERIOD:='7 days'}  # throughput data expire after 7 days
KEY_PREFIX=metric:throughput
KEY_PREFIX_RAW=$KEY_PREFIX:raw
KEY_PREFIX_STAT=$KEY_PREFIX:stat

err(){
    msg="$@"
    echo "ERROR: $msg" >&2
}

get_eths() {
    ls -l /sys/class/net | awk '/^l/ && !/virtual/ {print $9}'
}

get_vpns() {
    ls -l /sys/class/net | awk '/vpn_|tun_/ {print $9}'
}

logrun() {
    ${DEBUG:-false} && echo "> $@"
    rc=$(eval "$@")
}

record_raw_data() {
    ifx=$1
    while true; do
        # read data from system
        read rx0 tx0 < <( awk "/$ifx/ {print \$2\" \"\$10}" /proc/net/dev )
        sleep $SAMPLE_DURATION
        read rx1 tx1 < <( awk "/$ifx/ {print \$2\" \"\$10}" /proc/net/dev )
        ts=$(date +%s)
        let rxd=(rx1-rx0)/SAMPLE_DURATION
        let txd=(tx1-tx0)/SAMPLE_DURATION
        rx0=$rx1; tx0=$tx1
        logrun redis-cli zadd $KEY_PREFIX_RAW:$ifx:rx $rxd $ts
        logrun redis-cli zadd $KEY_PREFIX_RAW:$ifx:tx $txd $ts
        sleep $SAMPLE_INTERVAL
    done
}

clean_scan() {
    cursor=$1;shift
    ts_oldest=$1;shift
    redis_key=$1;shift

    redis-cli zscan $redis_key $cursor | {
        read new_cursor
        while read value
        do
            read score
            if [[ $value -lt $ts_oldest ]]
            then
                logrun redis-cli zrem $redis_key $value
            fi
        done
        if [[ $new_cursor -ne 0 ]]
        then
            clean_scan $new_cursor $ts_oldest $redis_key
        fi
    }
}

clean_old_data() {
    redis_key=$1
    ts_oldest=$(date -d "-$EXPIRE_PERIOD" +%s)
    clean_scan 0 $ts_oldest $redis_key
}

calc_metrics() {
    key_suffix=$1:$2
    while true
    do
        # clean out-of-date data
        clean_old_data $KEY_PREFIX_RAW:$key_suffix

        # calculate stats
        count=$(redis-cli zcard $KEY_PREFIX_RAW:$key_suffix)
        if [[ $count -gt 0 ]]
        then
            let idx_median=count/2
            let idx_pt75=(count*75)/100
            let idx_pt90=(count*90)/100
            val_min=$( redis-cli zrangebyscore $KEY_PREFIX_RAW:$key_suffix 0 +inf withscores limit 0 1 | tail -1 )
            val_median=$( redis-cli zrangebyscore $KEY_PREFIX_RAW:$key_suffix 0 +inf withscores limit $idx_median 1 | tail -1 )
            val_max=$( redis-cli zrevrangebyscore $KEY_PREFIX_RAW:$key_suffix +inf 0 withscores limit 0 1 | tail -1 )
            val_pt75=$( redis-cli zrangebyscore $KEY_PREFIX_RAW:$key_suffix 0 +inf withscores limit $idx_pt75 1 | tail -1 )
            val_pt90=$( redis-cli zrangebyscore $KEY_PREFIX_RAW:$key_suffix 0 +inf withscores limit $idx_pt90 1 | tail -1 )

            logrun redis-cli hmset $KEY_PREFIX_STAT:$key_suffix \
                min    $val_min \
                median $val_median \
                max    $val_max \
                pt75   $val_pt75 \
                pt90   $val_pt90
        fi
        sleep $CALC_INTERVAL
    done
    return 0
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

LOCK_FILE=/var/lock/network_metrics.lock
if [[ -e $LOCK_FILE ]] && kill -0 $(cat $LOCK_FILE)
then
    err "Another instance of $CMD is already running, abort"
    exit 1
else
    rm -f $LOCK_FILE
    echo $$ >$LOCK_FILE
fi

trap "{ rm -f $LOCK_FILE; }" INT TERM

# start recording raw data
for ifx in $(get_eths) $(get_vpns)
do
    record_raw_data $ifx &
done

# calculate stat data
for ifx in $(get_eths) $(get_vpns)
do
    for rt in rx tx
    do
        calc_metrics $ifx $rt &
    done
done

wait
