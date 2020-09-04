#!/bin/bash

# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------

CMD=$(basename $0)
CMDDIR=$(dirname $0)

: ${RUN_INTERVAL:=10}

# ----------------------------------------------------------------------------
# Functions
# ----------------------------------------------------------------------------
get_model() {
    case "$(uname -m)" in
        "x86_64") FIREWALLA_PLATFORM='gold' ;;
        "aarch64")
            if [[ -e /etc/firewalla-release ]]; then
                BOARD=$( . /etc/firewalla-release 2>/dev/null && echo $BOARD || cat /etc/firewalla-release )
            else
                BOARD='unknown'
            fi
            case $BOARD in
                navy) FIREWALLA_PLATFORM='navy' ;;
                blue) FIREWALLA_PLATFORM='blue' ;;
                   *) FIREWALLA_PLATFORM='unknown' ;;
            esac
            ;;
        "armv7l") FIREWALLA_PLATFORM='red' ;;
        *) FIREWALLA_PLATFORM='unknown' ;;
    esac
    echo $FIREWALLA_PLATFORM
}


node_cpu_frequency_khz() {
cat <<EOS

# HELP node_cpu_frequency_khz CPU frequency
# TYPE node_cpu_frequency_khz gauge
node_cpu_frequency_khz{cpu="0"} $(cpufreq-info -c 0 -f)
node_cpu_frequency_khz{cpu="1"} $(cpufreq-info -c 1 -f)
node_cpu_frequency_khz{cpu="2"} $(cpufreq-info -c 2 -f)
node_cpu_frequency_khz{cpu="3"} $(cpufreq-info -c 3 -f)
EOS
}

node_cpu_temperature_c() {
    cat <<EOH

# HELP node_cpu_temperature_c CPU temperature in Celcius
# TYPE node_cpu_temperature_c gauge
node_cpu_temperature_c $(cat /sys/class/thermal/thermal_zone0/temp)
EOH
}

node_cpu_usage_overall() {
    type mpstat >/dev/null || sudo apt install -y sysstat

    cat <<EOH

# HELP node_cpu_usage_overall CPU usage overall
# TYPE node_cpu_usage_overall gauge
EOH
mpstat -o JSON 2 1 | jq -r '.sysstat.hosts[0].statistics[0]."cpu-load"[]|del(.cpu)|to_entries[]|"node_cpu_usage_overall{stat=\"\(.key)\"} \(.value)"'
}

node_cpu_usage_process() {
    procs='zeek openvpn FireMain FireMon'
    cat <<EOH

# HELP node_cpu_usage_process CPU usage of given process
# TYPE node_cpu_usage_process gauge
EOH
    for proc in $procs; do
        cat <<EOL
node_cpu_usage_overall{proc="$proc"} $(ps aux |fgrep $proc|grep -v grep |awk '{print $3}' |sort -n |tail -1)
EOL
    done
}

node_network_xrate_bytes() {
    case $(get_model) in
        navy) intfs=$(ip --br l |awk '/(eth0|vpn_.*|tun_fwvpn)/ {print $1}') ;;
        gold) intfs=$(ip --br l |awk '/(eth[0-3]|vpn_.*|tun_fwvpn)/ {print $1}') ;;
        *) return ;;
    esac
    cat <<EOH

# HELP node_network_xrate_bytes Network transfer rate in bytes
# TYPE node_network_xrate_bytes gauge
EOH
    for intf in $intfs; do
        cat <<EOL
node_network_xrate_bytes{if="$intf",tr="rx"} $(bmon  -p "${intf}" -o format:fmt='$(attr:rxrate:bytes)\n',format:quitafter=2 | tail -1)
node_network_xrate_bytes{if="$intf",tr="tx"} $(bmon  -p "${intf}" -o format:fmt='$(attr:txrate:bytes)\n',format:quitafter=2 | tail -1)
EOL
    done
}

node_ping_gateway_ms() {
     gws=$(ip route | awk '$1 == "default" {print $3}')
    cat <<EOH

# HELP node_ping_gateway_ms Ping to gateway
# TYPE node_ping_gateway_ms gauge
EOH
     for gw in $gws; do
         ping -nc 6 $gw | awk '/rtt/ {print $4}'| {
             IFS=/ read min avg max mdev
             cat <<EOL
node_ping_gateway_ms gauge{gw="$gw",stat="min"}  $min
node_ping_gateway_ms gauge{gw="$gw",stat="avg"}  $avg
node_ping_gateway_ms gauge{gw="$gw",stat="max"}  $max
node_ping_gateway_ms gauge{gw="$gw",stat="mdev"} $mdev
EOL
         }
     done
}


collect_metrics() {
    node_network_xrate_bytes
    node_ping_gateway_ms
    node_cpu_temperature_c
    node_cpu_frequency_khz
    node_cpu_usage_overall
    node_cpu_usage_process
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

branch=$(git branch --show-current)
test $branch == 'master' || { exit 1; }

while sleep $RUN_INTERVAL; do
    collect_metrics &> /home/pi/.forever/perf.log
done

exit 0
