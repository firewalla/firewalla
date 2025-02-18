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
    for apcp in $AP_COLS
    do
        apc=${apcp%:*}; apcl=${apcp#*:}
        test $apcl == $apc && apcl=-20
        printf "%${apcl}s " ${apc^^}
        let HDR_LENGTH+=${apcl#-}+1
    done
    echo
}

frcc() {
    curl -s "http://localhost:8837/v1/config/active"
}

local_api() {
    curl -s "http://localhost:8841/v1/$1"
}

ap_config() {
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
    (( D == 0 )) && (( H == 0 )) && {
      (( M > 0 )) && printf '%02dm' $M
      printf '%02ds\n' $S
    }
}

convert_eth_speed() {
  if [[ $1 == '-1' ]]; then
    output=$NO_VALUE
  elif [[ $1 -ge 1000 ]]; then
    output=$(echo "scale=1;${1}/1000"|bc|sed 's/\.0//')G
  else
    output=${1}M
  fi
  echo "$output"
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

AP_COLS='version:-10 iversion:-10 device_ip:-16 device_vpn_ip:-16 uptime:6 hshake:8 sta:4 latency:7 branch:-8 eth0:6 eth1:6 act_up:9 bh_up_mac_rssi:-15 dev_mac:-8 name:-30'
AP_COLS="idx:-3 $AP_COLS"
print_header >&2; hl >&2
lines=0
timeit begin
ap_data=$(ap_config | jq -r ".assets|to_entries|sort_by(.key)[]|[.key, .value.sysConfig.meshMode//\"default\", .value.publicKey]|@tsv")
timeit ap_data
ap_status=$(local_api status/ap|jq -r ".info")
ap_status_mac=$(echo "$ap_status" |  jq -r  'to_entries[]|.key as $mac| .value.aps|map($mac, .bssid)|@tsv')
ap_status2=$(echo "$ap_status" | jq -r "to_entries[]|[.key,.value.branch,.value.ts,.value.version//\"${NO_VALUE}\",.value.imageVersion//\"${NO_VALUE}\",.value.sysUptime,(.value.eths|.eth0.linkSpeed//-1,.eth1.linkSpeed//-1),.value.activeUplink,.value.aps[\"ath2\"].upRssi//\"-\",.value.latencyToController, .value.aps[\"ath2\"].upBssid//\"-\"]|@tsv")
timeit ap_status
wg_dump=$(sudo wg show wg_ap dump)
timeit wg_dump
wg_ap_peers_pubkeys=$(frcc | jq -r '.interface.wireguard.wg_ap.peers[].publicKey')
ap_sta_counts=$(local_api status/station | jq -r '.info|to_entries[]|[.key, .value.assetUID]|@tsv')
timeit ap_sta_counts
now_ts=$(date +%s)
declare -a ap_names ap_ips
test -n "$ap_data" && while read ap_mac ap_meshmode ap_pubkey
do
    read ap_branch ap_last_handshake_ts ap_version ap_iversion ap_uptime eth0_speed eth1_speed ap_active_uplink ap_backhaul_up_rssi ap_latency ap_backhaul_up_bssid < <( echo "$ap_status2" | awk "\$1==\"$ap_mac\" {print \$2\" \"\$3\" \"\$4\" \"\$5\" \"\$6\" \"\$7\" \"\$8\" \"\$9\" \"\$10\" \"\$11\" \"\$12}")
    timeit read
    if [[ -n "$ap_pubkey" ]]; then
      echo "$wg_ap_peers_pubkeys" | fgrep -q $ap_pubkey && ap_adopted=adopted || ap_adopted=pending
    else
      ap_adopted=pending
    fi
    test -n "$ap_pubkey" || continue
    read ap_endpoint ap_vpn_ip < <(echo "$wg_dump"| awk "\$1==\"$ap_pubkey\" {print \$3\" \"\$4}")
    timeit read
    device_vpn_ip=${ap_vpn_ip/\/32/}
    ap_ip=${ap_endpoint%:*}
    if [[ -z "$ap_ip" || "$ap_ip" == '(none)' ]]; then
      ap_ip=$(redis-cli hget host:mac:$ap_mac ipv4Addr)
    fi
    ap_ips+=($device_vpn_ip)
    ap_name=$(redis-cli --raw hget host:mac:$ap_mac name || echo $NO_VALUE)
    ap_names+=("$ap_name")

    ap_last_handshake=$(test ${ap_last_handshake_ts:-0} -gt 0 && displaytime $((now_ts-ap_last_handshake_ts)) 2>/dev/null || echo "$NO_VALUE")
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
            iversion) apd=$ap_iversion ;;
            dev_mac) apd=${ap_mac: -8} ;;
            device_ip) apd=$ap_ip ;;
            device_vpn_ip) apd=$device_vpn_ip ;;
            uptime) apd=$(displaytime $ap_uptime) ;;
            branch) apd="$ap_branch" ;;
            hshake) apd="$ap_last_handshake" ;;
            sta) apd="$ap_stations_per_ap" ;;
            act_up) apd="${ap_active_uplink}" ;;
            bh_up_mac_rssi)
              if [[ "${ap_backhaul_up_bssid:0:9}" == '20:6D:31:' ]]; then
                bh_up_mac=$(echo "$ap_status_mac" | awk "/$ap_backhaul_up_bssid/ {print \$1}")
                apd="${bh_up_mac: -8}@$ap_backhaul_up_rssi"
              else
                apd=$NO_VALUE
              fi
              ;;
            latency) apd=$ap_latency ;;
            eth0) apd=$(convert_eth_speed $eth0_speed) ;;
            eth1) apd=$(convert_eth_speed $eth1_speed) ;;
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
done < <(echo "$ap_data")
timeit for-ap-data
tty_rows=$(stty size | awk '{print $1}')
(( lines > tty_rows-2 )) && {
    hl >&2; print_header >&2
}
