#!/bin/bash

# ----------------------------------------------------------------------------
# Description
# ----------------------------------------------------------------------------

# Record transferred bytes in redis as raw data
# Calculate throughput of given period(15min) as sample data
# Get metrics of sample data including mean/75p/90p

CMD=$(basename $0)
: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${INTERVAL_RAW_SEC:=10}
: ${INTERVAL_STAT_SEC:=30}
KEY_PREFIX=metric:throughput
KEY_PREFIX_RAW=$KEY_PREFIX:raw
KEY_PREFIX_STAT=$KEY_PREFIX:stat

err(){
    msg="$@"
    echo "ERROR: $msg" >&2
}

get_eths() {
    ls -l /sys/class/net | awk '/pci/ {print $9}'
}

logrun() {
    echo "> $@"
    rc=$(eval "$@")
}

record_raw_data() {
    ethx=$1
    read rx0 tx0 < <( awk "/$ethx/ {print \$2\" \"\$10}" /proc/net/dev )
    while true; do
        # read data from system
        sleep $INTERVAL_RAW_SEC
        read rx1 tx1 < <( awk "/$ethx/ {print \$2\" \"\$10}" /proc/net/dev )
        ts=$(date +%s)
        let rxd=(rx1-rx0)/INTERVAL_RAW_SEC
        let txd=(tx1-tx0)/INTERVAL_RAW_SEC
        rx0=$rx1; tx0=$tx1
        logrun redis-cli zadd $KEY_PREFIX_RAW:$ethx:rx $rxd $ts
        logrun redis-cli zadd $KEY_PREFIX_RAW:$ethx:tx $txd $ts
    done
}


calc_metrics() {
    key_suffix=$1:$2
    while true
    do
        count=$(redis-cli zcount $KEY_PREFIX_RAW:$key_suffix 0 +inf)
        let idx_median=count/2
        let idx_pt75=(count*75)/100
        let idx_pt90=(count*90)/100
        val_median=$( redis-cli zrangebyscore $KEY_PREFIX_RAW:$key_suffix 0 +inf withscores limit $idx_median 1 | tail -1 )
        val_pt75=$( redis-cli zrangebyscore $KEY_PREFIX_RAW:$key_suffix 0 +inf withscores limit $idx_pt75 1 | tail -1 )
        val_pt90=$( redis-cli zrangebyscore $KEY_PREFIX_RAW:$key_suffix 0 +inf withscores limit $idx_pt90 1 | tail -1 )

        logrun redis-cli hmset $KEY_PREFIX_STAT:$key_suffix \
            median $val_median \
            pt75   $val_pt75 \
            pt90   $val_pt90
        sleep $INTERVAL_STAT_SEC
    done
    return 0
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

# start recording raw data
for ethx in $(get_eths)
do
    record_raw_data $ethx &
done

# calculate stat data
for ethx in $(get_eths)
do
    for rt in rx tx
    do
        calc_metrics $ethx $rt &
    done
done

wait
