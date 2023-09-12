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
    for apcp in $AP_COLS
    do
        apc=${apcp%:*}; apcl=${apcp#*:}
        test $apcl == $apc && apcl=20
        printf "%-${apcl}s" ${apc^^}
    done
    echo
}

local_api() {
    curl -s "http://localhost:8837/v1/config/$1"
}

frcc() {
    local_api active
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

AP_COLS='name device_mac device_ip device_vpn_ip pub_key:48 last_handshake:30 sta_count:10 mesh_mode:10'
print_header
echo '-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------'
lines=0
ap_macs=$(local_api assets_status | jq -r '.info|keys|@tsv')
for ap_mac in $ap_macs
do
    let lines++
    ap_name=$(frcc | jq -r ".assets.\"$ap_mac\".sysConfig.name//\"n/a\"")
    ap_meshmode=$(frcc | jq -r ".assets.\"$ap_mac\".sysConfig.meshMode//\"default\"")
    ap_pubkey=$(frcc | jq -r ".assets.\"$ap_mac\".publicKey")
    test "$ap_pubkey" == null && continue
    ap_endpoint=$(sudo wg show wg_ap dump| awk "\$1 ==\"$ap_pubkey\" {print \$3}")
    ap_ip=${ap_endpoint%:*}
    ap_vpn_ip=$(sudo wg show wg_ap dump| awk "\$1 ==\"$ap_pubkey\" {print \$4}")
    ap_last_handshake_ts=$(sudo wg show wg_ap dump| awk "\$1 ==\"$ap_pubkey\" {print \$5}")
    ap_last_handshake=$(date -d @$ap_last_handshake_ts 2>/dev/null || echo 'n/a')
    ap_stations_per_ap=$(local_api sta_status | jq ".info|map(select(.assetUID==\"$ap_mac\"))|length")
    for apcp in $AP_COLS
    do
        apc=${apcp%:*}; apcl=${apcp#*:}
        test $apcl == $apc && apcl=20
        case $apc in
            name) apd=$ap_name ;;
            device_mac) apd=$ap_mac ;;
            pub_key) apd=$ap_pubkey ;;
            device_ip) apd=$ap_ip ;;
            device_vpn_ip) apd=$ap_vpn_ip ;;
            last_handshake) apd="$ap_last_handshake" ;;
            sta_count) apd="$ap_stations_per_ap" ;;
            mesh_mode) apd=$ap_meshmode ;;
            *) apd='n/a' ;;
        esac
        printf "%-${apcl}s" "$apd"
    done
    echo
done
tty_rows=$(stty size | awk '{print $1}')
(( lines > tty_rows-2 )) && {
    echo '-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------'
    print_header
}
