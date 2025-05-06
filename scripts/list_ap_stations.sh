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

  # List AP station status
  $0

  # List a specific station status
  $0 <station_mac>

EOU
}

STATION_MAC=$1

print_header() {
    HDR_LENGTH=0
    for stact in $STA_COLS
    do
        IFS=: read stac stacl stacu <<<$(echo $stact)
        test -n "$stacl" || stacl=-20
        printf "%${stacl}s " ${stac^^}
        let HDR_LENGTH+=${stacl#-}+1
    done
    echo
}

local_api() {
    curl -s "http://localhost:8841/v1/$1"
}

local_simple_post_api() {
    curl -XPOST -s "http://localhost:8841/v1/$1"
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
    echo "TIMEIT $1: $((tnow-tlast))" >&2
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

get_sta_name() {
  m=$1
  result=$(redis-cli --raw hget host:mac:$m name)
  test -n "$result" && {
    echo "$result"
    return 0
  }

  result=$(redis-cli --raw hget host:mac:$m detect|jq -r .name)
  test "$result" == null || {
    echo "$result"
    return 0
  }

  redis-cli --raw hget host:mac:$m bname
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

STA_COLS='sta_mac sta_ip:-17 ap_uid:9 band:4 chan:5 mimo:5 rssi:5 snr:5 tx:5 rx:5 intf:-8 vlan:5 dvlan:5 assoc_time:14 idle:6 hb_time:9 ssid:-15 ap_name:-20:u sta_name:-30:u'
(print_header; hl) >&2
lines=0
timeit begin

test -z "$STATION_MAC" || local_simple_post_api "control/monitor/$STATION_MAC"

while true; do
    if [[ -z "$STATION_MAC" ]]; then
        sta_data=$(local_api status/station| jq -r '.info|to_entries[]|[.key, .value.assetUID, .value.ssid, .value.band, .value.channel, .value.txnss, .value.rxnss, .value.rssi, .value.snr, .value.txRate, .value.rxRate, .value.intf, .value.assocTime, .value.ts, .value.idle, .value.dvlanVlanId, .value.vlanId]|@tsv')
    else 
        sta_data=$(local_api status/station/$STATION_MAC| jq -r '.info|[.macAddr, .assetUID, .ssid, .band, .channel, .txnss, .rxnss, .rssi, .snr, .txRate, .rxRate, .intf, .assocTime, .ts, .idle, .dvlanVlanId, .vlanId]|@tsv')
    fi
    timeit sta-data
    test -n "$sta_data" && echo "$sta_data" | while IFS=$'\t' read sta_mac ap_mac sta_ssid sta_band sta_channel sta_txnss sta_rxnss sta_rssi sta_snr sta_tx_rate sta_rx_rate sta_intf sta_assoc_time sta_ts sta_idle sta_dvlan sta_vlan
    do
        test -n "$sta_mac" || continue
        timeit read-$sta_mac
        sta_ip=$(redis-cli --raw hget host:mac:$sta_mac ipv4Addr)
        timeit sta_ip
        timeit read
        ap_name=$(redis-cli --raw hget host:mac:$ap_mac name || echo $NO_VALUE)
        timeit ap_name
        time_now=$(date +%s)
        timeit timestamp

        for stact in $STA_COLS
        do
            IFS=: read stac stacl stacu <<<$(echo $stact)
            timeit "process-col-$stac"
            test -n "$stacl" || stacl=-20
            case $stac in
                sta_mac) stad=$sta_mac ;;
                sta_ip) stad=$sta_ip ;;
                sta_name) stad=$(get_sta_name ${sta_mac^^}) ;;
                ap_uid) stad=${ap_mac:9} ;;
                ap_name) stad=$ap_name ;;
                ssid) stad=$sta_ssid ;;
                band) stad=$sta_band ;;
                chan) stad=$sta_channel ;;
                mimo) stad="${sta_txnss}x${sta_rxnss}" ;;
                rssi) stad=$sta_rssi ;;
                snr) stad=$sta_snr ;;
                vlan) stad=$sta_vlan ;;
                dvlan) stad=$sta_dvlan ;;
                idle) stad=$sta_idle ;;
                tx) stad=$sta_tx_rate ;;
                rx) stad=$sta_rx_rate ;;
                intf) stad=$sta_intf ;;
                assoc_time) stad=$(displaytime $sta_assoc_time) ;;
                hb_time) stad=$( displaytime $((time_now - sta_ts)) );;
                *) stad=$NO_VALUE ;;
            esac
            timeit "case-$stac"
            test -t 1 || stad=${stad// /_}
            stad=${stad//[‘’]/\'}
            stadl=${#stad}
            # process unicode string
            test "$stacu" == 'u' && {
                stadlu=$(perl -CSAD -E 'say length($ARGV[0])' -- "$stad")
                #stadlu=$(echo "$stad"|python3 -c 'v=input();print(len(v))')
                stadlL=$(echo "$stad" | wc -L)
                let stacld=stadl-stadlu*2+stadlL
                test $stadl -eq $stadlu || {
                    if [[ ${stacl:0:1} == '-' ]]; then
                        let stacl=stacl-stacld
                    else
                        let stacl=stacl+stacld
                    fi
                }
            }
            timeit 'stadcl-adjust'
            stacla=${stacl#-}
            if [[ $stadl -gt $stacla ]]
            then
                stad="${stad:0:$(((stacla-2)/2))}..${stad:$((stadl-(stacla-2)/2))}"
            fi
            printf "%${stacl}s " "${stad:-$NO_VALUE}"
            timeit 'printf'
        done
        let lines++
        echo
    done
    if [[ -z "$STATION_MAC" ]]; then
        break # no endlessly query when station mac is not specified
    fi
    sleep 2
done
timeit 'done'
tty_rows=$(stty size | awk '{print $1}')
(( lines > tty_rows-2 )) && {
    ( hl; print_header ) >&2
}
