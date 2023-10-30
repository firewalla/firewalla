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
    for apcp in $AP_COLS
    do
        apc=${apcp%:*}; apcl=${apcp#*:}
        test $apcl == $apc && apcl=-20
        printf "%${apcl}s " ${apc^^}
        let HDR_LENGTH+=${apcl#-}+1
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

AP_COLS='name:-30 version:-10 device_mac:-18 device_ip:-16 device_vpn_ip:-17 pub_key:48 uptime:16 last_handshake:30 sta:4 mesh_mode:10 eth_speed:15'
${CONNECT_AP} && AP_COLS="idx:-3 $AP_COLS"
(print_header; hl) >&2
lines=0
timeit begin
ap_data=$(frcc | jq -r ".assets|to_entries[]|[.key, .value.sysConfig.name//\"${NO_VALUE}\", .value.sysConfig.meshMode//\"default\", .value.publicKey]|@tsv")
timeit ap_data
ap_status=$(local_api assets/ap/status | jq -r ".info|to_entries[]|[.key,.value.version//\"${NO_VALUE}\",.value.sysUptime, .value.eths.eth0.connected, .value.eths.eth0.linkSpeed//\"${NO_VALUE}\"]|@tsv")
timeit ap_status
wg_dump=$(sudo wg show wg_ap dump)
timeit wg_dump
ap_sta_counts=$(local_api assets/ap/sta_status | jq -r '.info|to_entries[]|[.key, .value.assetUID]|@tsv')
timeit ap_sta_counts
declare -a ap_names ap_ips
while read ap_mac ap_version ap_uptime ap_eth_connected ap_eth_speed
do
    timeit $ap_mac
    ap_name=$(echo "$ap_data"| awk -F'\t' "/$ap_mac/ {print \$2}")
    ap_names+=($ap_name)
    timeit ap_name
    ap_meshmode=$(echo "$ap_data"| awk -F'\t' "/$ap_mac/ {print \$3}")
    timeit ap_meshmode
    ap_pubkey=$(echo "$ap_data"| awk -F'\t' "/$ap_mac/ {print \$4}")
    timeit ap_pubkey
    test "$ap_pubkey" == null && continue
    read ap_endpoint ap_vpn_ip ap_last_handshake_ts < <(echo "$wg_dump"| awk "\$1==\"$ap_pubkey\" {print \$3\" \"\$4\" \"\$5}")
    timeit read
    ap_ip=${ap_endpoint%:*}
    ${CONNECT_AP} && {
        if [[ -z "$ap_ip" || "$ap_ip" == '(none)' ]]; then continue; fi
    }
    ap_ips+=($ap_ip)
    ap_last_handshake=$(date -d @$ap_last_handshake_ts 2>/dev/null || echo "$NO_VALUE")
    ap_stations_per_ap=$(echo "$ap_sta_counts" | fgrep -c $ap_mac)
    timeit ap_stations_per_ap
    for apcp in $AP_COLS
    do
        apc=${apcp%:*}; apcl=${apcp#*:}
        test $apcl == $apc && apcl=-20
        case $apc in
            idx) let apd=lines ;;
            name) apd=$ap_name ;;
            version) apd=$ap_version ;;
            device_mac) apd=$ap_mac ;;
            pub_key) apd=$ap_pubkey ;;
            device_ip) apd=$ap_ip ;;
            device_vpn_ip) apd=$ap_vpn_ip ;;
            uptime) apd=$(displaytime $ap_uptime) ;;
            last_handshake) apd="$ap_last_handshake" ;;
            sta) apd="$ap_stations_per_ap" ;;
            mesh_mode) apd=$ap_meshmode ;;
            eth_speed)
                case $ap_eth_connected in
                  true) apd=$ap_eth_speed ;;
                  false) apd='disconnected' ;;
                  *) apd=$NO_VALUE ;;
                esac
                ;;
            *) apd=$NO_VALUE ;;
        esac
        apcla=${apcl#-}
        test -t 1 || apd=$(echo "$apd" | sed -e "s/ /_/g")
        apd=$(echo "$apd" | sed -e "s/[‘’]/'/g")
        apdl=${#apd}
        if [[ $apdl -gt $apcla ]]
        then
            apd="${apd:0:$(((apcla-2)/2))}..${apd:$((apdl-(apcla-2)/2))}"
        fi

        printf "%${apcl}s " "${apd:-$NO_VALUE}"
    done
    timeit for-apcp
    let lines++
    echo
done < <(echo "$ap_status")
timeit for-apmac
tty_rows=$(stty size | awk '{print $1}')
(( lines > tty_rows-2 )) && {
    (hl; print_header) >&2
}
${CONNECT_AP} && {
    while read -p "Select index to SSH to:" si
    do
        if (( $si < $lines && $si >=0 )) ; then  break; fi
    done
    echo ">>ssh to '${ap_names[$si]}' at ${ap_ips[$si]} ..."
    ssh -o HostKeyAlgorithms=+ssh-rsa root@${ap_ips[$si]}
}
