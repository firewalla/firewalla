#!/bin/bash

CMD=${0##*/}
DATE_FORMAT='[%Y-%m-%d %H:%M:%S]'
LOG_QUIET=0
LOG_ERROR=1
LOG_WARN=2
LOG_INFO=3
LOG_DEBUG=4

: ${LOGLEVEL:=$LOG_INFO}
test -t 1 || NO_VALUE=_
: ${NO_VALUE:=' '}

# ----------------------------------------------------------------------------
# Functions
# ----------------------------------------------------------------------------

mylog() {
    echo "$(date +"$DATE_FORMAT")$@"
}
mylogn() {
    echo -n "$(date +"$DATE_FORMAT")$@"
}

logdebug() {
    test $LOGLEVEL -ge $LOG_DEBUG || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[DEBUG] $@" >&2
    else
        mylog "[DEBUG] $@" >&2
    fi
}

loginfo() {
    test $LOGLEVEL -ge $LOG_INFO || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[INFO] $@"
    else
        mylog "[INFO] $@"
    fi
}

logwarn() {
    test $LOGLEVEL -ge $LOG_WARN || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[WARN] $@" >&2
    else
        mylog "[WARN] $@" >&2
    fi
}

logerror() {
    test $LOGLEVEL -ge $LOG_ERROR || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[ERROR] $@" >&2
    else
        mylog "[ERROR] $@" >&2
    fi
}

usage() {
  cat <<EOU
usage: $CMD

env:

  LOGLEVEL: $LOGLEVEL

examples:

  # List AP status
  $0

EOU
}

print_header() {
    HDR_LENGTH=0
    for stacp in $STA_COLS
    do
        stac=${stacp%:*}; stacl=${stacp#*:}
        test $stacl == $stac && stacl=-20
        printf "%${stacl}s " ${stac^^}
        let HDR_LENGTH+=${stacl#-}+1
    done
    echo
}

local_api() {
    curl -s "http://localhost:8837/v1/$1"
}

frcc() {
    local_api config/active
}

hl() {
    ${HEADER:-true} || return 0
    for ((i=0;i<HDR_LENGTH;i++)); do
        echo -n '-'
    done
    echo
}

timeit() {
    return 0
    tnow=$(date +%s%3N)
    echo "TIMEIT $1: $((tnow-tlast))"
    tlast=$tnow
}

displaytime() {
    ${FORMAT_TIME:-true} || {
        echo "$1"
        return 0
    }
    local T=$1
    local D=$((T/60/60/24))
    local H=$((T/60/60%24))
    local M=$((T/60%60))
    local S=$((T%60))
    (( D > 0 )) && printf '%02dd' $D
    (( H > 0 )) && printf '%02dh' $H
    (( M > 0 )) && printf '%02dm' $M
    printf '%02ds\n' $S
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

STA_COLS='sta_mac sta_ip:-17 sta_name:30 ap_mac ap_name ssid:-15 chan:5 rssi:5 snr:5 assocTime:16 timestamp:28'
(print_header; hl) >&2
lines=0
timeit begin
ap_mac_name=$(frcc | jq -r ".assets|to_entries[]|[.key, .value.sysConfig.name//\"${NO_VALUE}\"]|@tsv")
timeit ap_mac_name
arp_an=$(arp -an| awk '/:/ {print $2" "$4}'|tr -d '()')
timeit arp_an
sta_data=$(local_api assets/ap/sta_status| jq -r '.info|to_entries[]|[.key, .value.assetUID, .value.ssid, .value.channel, .value.rssi, .value.snr, .value.assoc_time, .value.ts]|@tsv')
test -n "$sta_data" && echo "$sta_data" | while read sta_mac ap_mac sta_ssid sta_channel sta_rssi sta_snr sta_assoc_time sta_ts
do
    test -n "$sta_mac" || continue
    timeit $sta_mac
    sta_ip=$(echo "$arp_an" | awk "/${sta_mac,,}/ {print \$1}")
    timeit sta_ip
    timeit read
    ap_name=$(echo "$ap_mac_name"| awk -F'\t' "/$ap_mac/ {print \$2}")
    timeit ap_name
    sta_timestamp=$(date -d @$sta_ts 2>/dev/null || echo $NO_VALUE)
    timeit timestamp

    for stacp in $STA_COLS
    do
        stac=${stacp%:*}; stacl=${stacp#*:}
        timeit $stac
        test $stacl == $stac && stacl=-20
        case $stac in
            sta_mac) stad=$sta_mac ;;
            sta_ip) stad=$sta_ip ;;
            sta_name) stad=$(redis-cli hget host:mac:${sta_mac^^} bname) ;;
            ap_mac) stad=$ap_mac ;;
            ap_name) stad=$ap_name ;;
            ssid) stad=$sta_ssid ;;
            chan) stad=$sta_channel ;;
            rssi) stad=$sta_rssi ;;
            snr) stad=$sta_snr ;;
            assoc_time) stad=$(displaytime $sta_assoc_time) ;;
            timestamp) stad=$sta_timestamp ;;
            *) stad=$NO_VALUE ;;
        esac
        stacla=${stacl#-}
        test -t 1 || stad=$(echo "$stad" | sed -e "s/ /_/g")
        stad=$(echo "$stad" | sed -e "s/[‘’]/'/g")
        stadl=${#stad}
        if [[ $stadl -gt $stacla ]]
        then
            stad="${stad:0:$(((stacla-2)/2))}..${stad:$((stadl-(stacla-2)/2))}"
        fi
        timeit 'case'
        printf "%${stacl}s " "${stad:-$NO_VALUE}"
        timeit 'printf'
    done
    let lines++
    echo
done
timeit 'done'
tty_rows=$(stty size | awk '{print $1}')
(( lines > tty_rows-2 )) && {
    ( hl; print_header ) >&2
}
