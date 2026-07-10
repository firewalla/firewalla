#!/bin/bash

CMD=${0##*/}
DATE_FORMAT='[%Y-%m-%d %H:%M:%S]'
LOG_QUIET=0
LOG_ERROR=1
LOG_WARN=2
LOG_INFO=3
LOG_DEBUG=4

: ${LOGLEVEL:=$LOG_INFO}
: ${CONNECT_AP:=false}
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
    for ssidcp in $SSID_COLS
    do
        ssidc=${ssidcp%:*}; ssidcl=${ssidcp#*:}
        test $ssidcl == $ssidc && ssidcl=-20
        printf "%${ssidcl}s " ${ssidc^^}
        let HDR_LENGTH+=${ssidcl#-}+1
    done
    echo
}

local_api() {
    curl -s "http://localhost:8841/v1/$1"
}

frcc() {
    local_api config/active
}

hl() {
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

SSID_COLS='ap_mac:-18 bssid:-18 channel:9 band:4 maxrate:10 tx_pwr:6 sta_count:10 intf:-10 ssid ap_name:-30'
{ print_header >&2; hl >&2; }
lines=0
timeit begin
ssids=$(frcc | jq -r '.profile[], .assets_template.ap_default.mesh|.ssid' | sort | uniq)
timeit ssids
ssid_data=$(local_api status/ap | jq -r ".info|to_entries[]|.key as \$mac|.value.aps |map(select(.mode==\"ap\")) |to_entries[] |.value|[.ssid//\"x\", \$mac, .bssid,.channel,.band,.txPower,.maxRate//\"$NO_VALUE\", .intf//\"$NO_VALUE\"]|@tsv" )
ssid_sta_bssid=$(local_api status/station | jq -r '.info|to_entries|map(select(.value.bssid != null)|[.value.ssid, .key, .value.bssid])[]|@tsv')
while read ssid
do
    timeit $ssid
    while IFS=$'\t' read ssid ap_mac bssid channel band tx_power maxrate intf
    do
        sta_count=$(echo "$ssid_sta_bssid" | awk "\$1==\"$ssid\" && \$3==\"$bssid\"" |wc -l)
        timeit sta_count
        for ssidcp in $SSID_COLS
        do
            ssidc=${ssidcp%:*}; ssidcl=${ssidcp#*:}
            test $ssidcl == $ssidc && ssidcl=-20
            case $ssidc in
                idx) let ssidd=lines ;;
                ap_name) ssidd=$(redis-cli --raw hget host:mac:$ap_mac name || echo "$NO_VALUE") ;;
                ap_mac) ssidd=$ap_mac ;;
                ssid) ssidd=$ssid ;;
                intf) ssidd=$intf ;;
                bssid) ssidd=$bssid ;;
                channel) ssidd=$channel ;;
                band) ssidd=$band ;;
                maxrate) ssidd=$maxrate ;;
                tx_pwr) ssidd=$tx_power ;;
                sta_count) ssidd=$sta_count ;;
                *) ssidd=$NO_VALUE ;;
            esac
            ssidcla=${ssidcl#-}
            test -t 1 || ssidd=$(echo "$ssidd" | sed -e "s/ /_/g")
            ssidd=$(echo "$ssidd" | sed -e "s/[‘’]/'/g")
            ssiddl=${#ssidd}
            if [[ $ssiddl -gt $ssidcla ]]
            then
                ssidd="${ssidd:0:$(((ssidcla-2)/2))}..${ssidd:$((ssiddl-(ssidcla-2)/2))}"
            fi

            printf "%${ssidcl}s " "${ssidd:-$NO_VALUE}"
        done
        timeit for-ssidcp
        let lines++
        echo
    done < <( echo "$ssid_data" | awk -F'\t' "\$1 == \"$ssid\"" )
done < <(echo "$ssids")
timeit while-ssid
tty_rows=$(stty size | awk '{print $1}')
(( lines > tty_rows-2 )) && {
    { hl >&2; print_header>&2; }
}
