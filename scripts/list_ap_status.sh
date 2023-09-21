#!/bin/bash

CMD=${0##*/}
DATE_FORMAT='[%Y-%m-%d %H:%M:%S]'
LOG_QUIET=0
LOG_ERROR=1
LOG_WARN=2
LOG_INFO=3
LOG_DEBUG=4

: ${LOGLEVEL:=$LOG_INFO}

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

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

AP_COLS='name:-30 version:-10 device_mac device_ip:-17 device_vpn_ip:-17 pub_key:48 last_handshake:30 sta:4 mesh_mode:10'
print_header; hl
lines=0
timeit begin
ap_data=$(frcc | jq -r '.assets|to_entries[]|[.key, .value.sysConfig.name//"n/a", .value.sysConfig.meshMode//"default", .value.publicKey]|@tsv')
timeit ap_data
ap_mac_version=$(local_api assets/ap/status | jq -r '.info|to_entries[]|[.key,.value.version//"n/a"]|@tsv')
timeit ap_mac_version
wg_dump=$(sudo wg show wg_ap dump)
timeit wg_dump
ap_sta_counts=$(local_api assets/ap/sta_status | jq -r '.info|to_entries[]|[.key, .value.assetUID]|@tsv')
timeit ap_sta_counts
echo "$ap_mac_version" | while read ap_mac ap_version
do
    timeit $ap_mac
    ap_name=$(echo "$ap_data"| awk "/$ap_mac/ {print \$2}")
    timeit ap_name
    ap_meshmode=$(echo "$ap_data"| awk "/$ap_mac/ {print \$3}")
    timeit ap_meshmode
    ap_pubkey=$(echo "$ap_data"| awk "/$ap_mac/ {print \$4}")
    timeit ap_pubkey
    test "$ap_pubkey" == null && continue
    read ap_endpoint ap_vpn_ip ap_last_handshake_ts < <(echo "$wg_dump"| awk "\$1==\"$ap_pubkey\" {print \$3\" \"\$4\" \"\$5}")
    timeit read
    ap_ip=${ap_endpoint%:*}
    ap_last_handshake=$(date -d @$ap_last_handshake_ts 2>/dev/null || echo 'n/a')
    ap_stations_per_ap=$(echo "$ap_sta_counts" | fgrep -c $ap_mac)
    timeit ap_stations_per_ap
    for apcp in $AP_COLS
    do
        apc=${apcp%:*}; apcl=${apcp#*:}
        test $apcl == $apc && apcl=-20
        case $apc in
            name)
                apcla=${apcl#-}
                if [[ ${#ap_name} -ge ${apcla} ]]
                then
                    apd="${ap_name:0:$((apcla-4))}..."
                else
                    apd=$ap_name
                fi
                ;;
            version) apd=$ap_version ;;
            device_mac) apd=$ap_mac ;;
            pub_key) apd=$ap_pubkey ;;
            device_ip) apd=$ap_ip ;;
            device_vpn_ip) apd=$ap_vpn_ip ;;
            last_handshake) apd="$ap_last_handshake" ;;
            sta) apd="$ap_stations_per_ap" ;;
            mesh_mode) apd=$ap_meshmode ;;
            *) apd='n/a' ;;
        esac
        printf "%${apcl}s " "${apd:-n/a}"
    done
    timeit for-apcp
    let lines++
    echo
done
timeit for-apmac
tty_rows=$(stty size | awk '{print $1}')
(( lines > tty_rows-2 )) && {
    hl; print_header
}
