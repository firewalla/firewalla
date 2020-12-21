#!/bin/bash

# ----------------------------------------------------------------------------
# Description
# ----------------------------------------------------------------------------

# Record network latency data in redis with both raw and stat data 
# Stat data is calculated at 2 levels
#   * within a sampling period
#   * all times

CMD=$(basename $0)
: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${SAMPLE_COUNT:=20}         # number of samples to record for each sample period
: ${SAMPLE_PERIOD:=300}       # every number of seconds to sample at
: ${CALC_INTERVAL:=300}       # every number of seconds to calculate stats at
: ${EXPIRE_PERIOD:='7 days'}  # time period for data to expire

KEY_PREFIX=metric:monitor
KEY_PREFIX_RAW=$KEY_PREFIX:raw
KEY_PREFIX_STAT=$KEY_PREFIX:stat

PING_TARGETS='1.1.1.1 9.9.9.9'

mylog() {
    echo "$(date): $@"
}

loginfo() {
    mylog "INFO: $@"
}

logerror() {
    mylog "ERROR: $@" >&2
}

logdebug() {
    ${DEBUG:-false} && mylog "DEBUG: $@" >&2
}

logrun() {
    ${DEBUG:-false} && mylog "> $@"
    rc=$(eval "$@")
}

get_bucket_timestamp() {
    t=$1
    let t=t-t%SAMPLE_PERIOD
    echo $t
}

get_fping_latency() {
    fping -C${SAMPLE_COUNT} -q -B1 -r1 $PING_TARGETS 2>&1
}

run_sample_once() {
    ts=$1
    loginfo "sample once at $ts ..."

    get_fping_latency |\
      while read ping_name colon pings; do
        logdebug "ping_name=$ping_name"
        logdebug "pings=$pings"
        key=$KEY_PREFIX_RAW:ping:$ping_name
        pings_json=$(echo $pings | tr ' ' '\n' | jq -R . | jq -s . | jq -cr .)
        logdebug "pings_json=$pings_json"
        stats_json=$(echo $pings_json| jq '{loss: map(select(.=="-"))|length, min:map(tonumber?)|min, max:map(tonumber?)|max, median: map(tonumber?)|(sort|if length%2==1 then .[length/2|floor] else [.[length/2-1,length/2]]|add/2 end)}')
        logrun "redis-cli hset $key $ts '{\"data\":$pings_json, \"stats\":$stats_json}'"
      done
}

run_sample() {
    loginfo "start sampling ..."
    time_last=0
    while sleep 1; do
        time_now=$(get_bucket_timestamp $(date +%s))
        logdebug "time_last: $time_last"
        logdebug "time_now: $time_now"
        if (( time_now > time_last )); then
            run_sample_once $time_now
            time_last=$time_now
        fi
    done
}

calc_metrics() {
    loginfo "start calculate metrics ..."
    return 0
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

LOCK_FILE=/var/lock/${CMD/.sh/.lock}
if [[ -e $LOCK_FILE ]] && kill -0 $(cat $LOCK_FILE)
then
    logerror "Another instance of $CMD is already running, abort"
    exit 1
else
    rm -f $LOCK_FILE
    echo $$ >$LOCK_FILE
fi


# start sampling
run_sample &
PID_SAMPLE=$!

# start calculate stats
calc_metrics &
PID_CALC=$!

trap "{ rm -f $LOCK_FILE; kill $PID_SAMPLE $PID_CALC; }" INT TERM

wait
