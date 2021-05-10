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

: ${SAMPLE_TYPES:='ping dns http'}
: ${PING_SAMPLE_COUNT:=20}         # number of samples to record for each sample period
: ${PING_SAMPLE_PERIOD:=300}       # every number of seconds to sample at
: ${PING_TARGETS:='1.1.1.1 9.9.9.9'}
: ${DNS_SAMPLE_COUNT:=5}         # number of samples to record for each sample period
: ${DNS_SAMPLE_PERIOD:=180}       # every number of seconds to sample at
: ${DNS_TARGETS:='1.1.1.1 8.8.8.8'}
: ${HTTP_SAMPLE_COUNT:=5}         # number of samples to record for each sample period
: ${HTTP_SAMPLE_PERIOD:=60}       # every number of seconds to sample at
: ${HTTP_TARGETS:='https://check.firewalla.com https://google.com/generate_204'}
: ${CALC_INTERVAL:=300}       # every number of seconds to calculate stats at
: ${EXPIRE_PERIOD:='3 days'}  # time period for data to expire

KEY_PREFIX=metric:monitor
KEY_PREFIX_RAW=$KEY_PREFIX:raw
KEY_PREFIX_STAT=$KEY_PREFIX:stat


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

get_timestamp_bucket() {
    st=$1
    t=$2
    vname="${st^^}_SAMPLE_PERIOD"
    sp=${!vname}
    let t=t-t%sp
    echo $t
}

get_fping_latency() {
    fping -C${PING_SAMPLE_COUNT} -q -B1 -r1 $PING_TARGETS 2>&1
}

get_stats() {
    jq '{loss: map(select(.=="-"))|length, min:map(tonumber?)|min, max:map(tonumber?)|max, median: map(tonumber?)|(sort|if length%2==1 then .[length/2|floor] else [.[length/2-1,length/2]]|add/2 end)}'
}

record_data_with_stats_in_redis() {
    sample_type=$1
    sample_target=$2
    sample_data=$3
    data_json=$(echo $sample_data | tr ' ' '\n' | jq -R . | jq -s . | jq -cr .)
    stats_json=$(echo $data_json | get_stats)
    logdebug "data_json=$data_json"
    key=$KEY_PREFIX_RAW:${sample_type}:${sample_target}
    logrun "redis-cli hset $key $ts '{\"data\":$data_json, \"stats\":$stats_json}'"
}

sample_ping() {
    ts=$1
    loginfo "sample PING at $ts ..."
    get_fping_latency |\
      while read ping_target colon pings; do
        record_data_with_stats_in_redis ping $ping_target "$pings"
      done
}

sample_dns() {
    ts=$1
    loginfo "sample DNS at $ts ..."
    for dt in $DNS_TARGETS; do
        data=""
        for ((i=0;i<DNS_SAMPLE_COUNT;i++)); do
            data_point=$( /usr/bin/dig @${dt} help.firewalla.com | awk '/Query time:/ {print $4}')
            data="${data} $data_point"
        done
        record_data_with_stats_in_redis dns $dt "$data"
    done

}

sample_http() {
    ts=$1
    loginfo "sample HTTP at $ts ..."
    for ht in $HTTP_TARGETS; do
        data=""
        for ((i=0;i<HTTP_SAMPLE_COUNT;i++)); do
            data_point=$(curl -s -m 10 -w '%{time_total}\n' -L "$ht")
            data="${data} $data_point"
        done
        record_data_with_stats_in_redis http $ht "$data"
    done
}

run_sample_once() {
    st=$1
    ts=$2
    loginfo "sample $st once at $ts ..."
    case $st in
        ping) sample_ping $ts ;;
        dns) sample_dns $ts ;;
        http) sample_http $ts ;;
        *) logerror "unknown sample type $st"; return 1;;
    esac
    return 0
}

run_sample() {
    sample_type=$1
    loginfo "start sampling ${sample_type} ..."
    tb_last=0
    while sleep 1; do
        tb_now=$(get_timestamp_bucket $sample_type $(date +%s))
        logdebug "tb_last: $tb_last"
        logdebug "tb_now: $tb_now"
        if (( tb_now > tb_last )); then
            run_sample_once $sample_type $tb_now
            tb_last=$tb_now
        fi
    done
}

scan_data() {
    rkey=$1
    cursor=$2
    ts=$3
    redis-cli hscan $rkey $cursor | jq -c . | {
        read cursor
        while read hkey; do
            read hval
            if [[ -n "$ts" && $ts -gt $hkey ]]; then
                redis-cli hdel $rkey $hkey &> /dev/null
            else
                echo "$hval" | jq -r '.data[]|tonumber?'
            fi
        done
        if [[ $cursor -ne 0 ]]; then
            scan_data $rkey $cursor
        fi
    }
}

calc_metrics() {

    sample_type=$1

    while true; do

        ts_since=$(date -d "-$EXPIRE_PERIOD" +%s)
        loginfo "start calculate metrics on $sample_type since $(date -d @$ts_since) ..."

        targets_var="${sample_type^^}_TARGETS"
        # clean data during calculation
        for sample_target in ${!targets_var}; do
            rkey=$KEY_PREFIX_RAW:$sample_type:$sample_target
            all_data_sorted=$(scan_data $rkey 0 $ts_since | sort -n)
            test -n "$all_data_sorted" || continue
            all_min=$(echo "$all_data_sorted"|head -1)
            all_max=$(echo "$all_data_sorted"|tail -1)
            all_size=$(echo "$all_data_sorted" | wc -l)
            if (( all_size%2 == 0 )) ; then
                let mid1=all_size/2
                let mid2=all_size/2+1
                all_median=$(echo "$all_data_sorted" | sed -ne "$mid1,$mid2 p"|awk '{x+=$1;} END{print x/2;}')
            else
                let mid=(all_size+1)/2
                all_median=$(echo "$all_data_sorted"| sed -ne "${mid}p")
            fi
            redis-cli hset $KEY_PREFIX_STAT:$sample_type:$sample_target min $all_min
            redis-cli hset $KEY_PREFIX_STAT:$sample_type:$sample_target max $all_max
            redis-cli hset $KEY_PREFIX_STAT:$sample_type:$sample_target median $all_median
        done

        sleep $CALC_INTERVAL

    done
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
for st in $SAMPLE_TYPES; do
    run_sample $st &
    PIDS="$PIDS $!"
done

# start calculate stats
for st in $SAMPLE_TYPES; do
    calc_metrics $st &
    PIDS="$PIDS $!"
done

trap "{ rm -f $LOCK_FILE; kill $PIDS; }" INT TERM

wait
