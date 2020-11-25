#!/bin/bash

# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------

CMD=$(basename $0)
CMDDIR=$(dirname $0)
OUTPUT_SHELL='sh'
OUTPUT_PROM='prom'
: ${OUTPUT_FORMAT:=$OUTPUT_SHELL}
: ${RUN_INTERVAL:=10}
: ${SHOW_HEADER:=true}

shopt -s lastpipe

# ----------------------------------------------------------------------------
# Functions
# ----------------------------------------------------------------------------

err() {
    echo "ERROR: $@" >&2
}

usage() {
    cat <<EOU
uasge: $0 [-f {$OUTPUT_SHELL|$OUTPUT_PROM}]
option:
    -f {$OUTPUT_SHELL|$OUTPUT_PROM}
       Output format:
         $OUTPUT_SHELL - space separated shell format, this is default.
         $OUTPUT_PROM - node-exporter collector format of Prometheus.
EOU
}

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

    # collect data
    c0=$(cpufreq-info -c 0 -f)
    c1=$(cpufreq-info -c 1 -f)
    c2=$(cpufreq-info -c 2 -f)
    c3=$(cpufreq-info -c 3 -f)

    # output
    case $OUTPUT_FORMAT in

        $OUTPUT_SHELL)
            cat <<EOS
cpufreq_0 $c0
cpufreq_1 $c1
cpufreq_2 $c2
cpufreq_3 $c3
EOS
            ;;

        $OUTPUT_PROM)
            cat <<EOP

# HELP node_cpu_frequency_khz CPU frequency
# TYPE node_cpu_frequency_khz gauge
node_cpu_frequency_khz{cpu="0"} $c0
node_cpu_frequency_khz{cpu="1"} $c1
node_cpu_frequency_khz{cpu="2"} $c2
node_cpu_frequency_khz{cpu="3"} $c3
EOP
            ;;
    esac
}

node_cpu_temperature_c() {

    # collect data
    cpu_temp=$(cat /sys/class/thermal/thermal_zone0/temp)

    # output
    case $OUTPUT_FORMAT in
    
        $OUTPUT_SHELL)
            echo "temp $cpu_temp"
            ;;

        $OUTPUT_PROM)
            cat <<EOP

# HELP node_cpu_temperature_c CPU temperature in Celcius
# TYPE node_cpu_temperature_c gauge
node_cpu_temperature_c $cpu_temp
EOP
            ;;
    esac
}

node_cpu_usage_overall() {
    type mpstat >/dev/null || sudo apt install -y sysstat

    # output
    case $OUTPUT_FORMAT in
    
        $OUTPUT_SHELL)
            mpstat -o JSON 2 1 | jq -r '.sysstat.hosts[0].statistics[0]."cpu-load"[]|del(.cpu)|to_entries[]|"cpu_\(.key) \(.value)"'
            ;;

        $OUTPUT_PROM)
            cat <<EOH

# HELP node_cpu_usage_overall CPU usage overall
# TYPE node_cpu_usage_overall gauge
EOH
            mpstat -o JSON 2 1 | jq -r '.sysstat.hosts[0].statistics[0]."cpu-load"[]|del(.cpu)|to_entries[]|"node_cpu_usage_overall{stat=\"\(.key)\"} \(.value)"'
            ;;
     esac
}

node_cpu_usage_process() {

    # collect
    cpu_usage_zeek=$(top -b -n1 |awk '$12 == "zeek" {print $9}')
    cpu_usage_openvpn=$(top -b -n1 |awk '$12 == "openvpn" {print $9}')
    cpu_usage_firemain=$(top -b -n1 -c|awk '$12 == "FireMain" {print $9}')
    cpu_usage_firemon=$(top -b -n1 -c|awk '$12 == "FireMon" {print $9}')

    cpu_usage_zeek=${cpu_usage_zeek:-0}
    cpu_usage_openvpn=${cpu_usage_openvpn:-0}
    cpu_usage_firemain=${cpu_usage_firemain:-0}
    cpu_usage_firemon=${cpu_usage_firemon:-0}

    # output
    case $OUTPUT_FORMAT in
    
        $OUTPUT_SHELL)
            cat <<EOS
p_zeek $cpu_usage_zeek
p_openvpn $cpu_usage_openvpn
p_firemain $cpu_usage_firemain
p_firemon $cpu_usage_firemon
EOS
            ;;

        $OUTPUT_PROM)
            cat <<EOP

# HELP node_cpu_usage_process CPU usage of given process
# TYPE node_cpu_usage_process gauge
node_cpu_usage_overall{proc="zeek"} $cpu_usage_zeek
node_cpu_usage_overall{proc="openvpn"} $cpu_usage_openvpn
node_cpu_usage_overall{proc="firemain"} $cpu_usage_firemain
node_cpu_usage_overall{proc="firemon"} $cpu_usage_firemon
EOP
            ;;
    esac
}

node_network_xrate_bytes() {
    case $(get_model) in
        navy) intfs=$(ip --br l |awk '/(eth0|vpn_.*|tun_fwvpn)/ {print $1}') ;;
        gold) intfs=$(ip --br l |awk '/(eth[0-3]|vpn_.*|tun_fwvpn)/ {print $1}') ;;
        *) return ;;
    esac

    # output
    case $OUTPUT_FORMAT in

        $OUTPUT_SHELL)
            for intf in $intfs; do
                cat <<EOL
${intf}_rx $(bmon -p "${intf}" -o format:fmt='$(attr:rxrate:bytes)\n',format:quitafter=2 | tail -1 |sed 's/\..*//')
${intf}_tx $(bmon -p "${intf}" -o format:fmt='$(attr:txrate:bytes)\n',format:quitafter=2 | tail -1 |sed 's/\..*//')
EOL
            done
            ;;

        $OUTPUT_PROM)
            cat <<EOH

# HELP node_network_xrate_bytes Network transfer rate in bytes
# TYPE node_network_xrate_bytes gauge
EOH
            for intf in $intfs; do
                cat <<EOL
node_network_xrate_bytes{if="$intf",tr="rx"} $(bmon  -p "${intf}" -o format:fmt='$(attr:rxrate:bytes)\n',format:quitafter=2 | tail -1|sed 's/\..*//')
node_network_xrate_bytes{if="$intf",tr="tx"} $(bmon  -p "${intf}" -o format:fmt='$(attr:txrate:bytes)\n',format:quitafter=2 | tail -1|sed 's/\..*//')
EOL
            done
            ;;
    esac
}

node_ping_gateway_ms() {

    # collect
    gw=$(ip route | awk '$1 == "default" {print $3}'| head -1)

    # output
    case $OUTPUT_FORMAT in

        $OUTPUT_SHELL)
            ping -nc 6 $gw | awk '/rtt/ {print $4}'| {
                IFS=/ read min avg max mdev
                cat <<EOL
ping_min  $min
ping_avg  $avg
ping_max  $max
ping_mdev $mdev
EOL
            }
            ;;

        $OUTPUT_PROM)
            cat <<EOH

# HELP node_ping_gateway_ms Ping to gateway
# TYPE node_ping_gateway_ms gauge
EOH
            ping -nc 6 $gw | awk '/rtt/ {print $4}'| {
                IFS=/ read min avg max mdev
                cat <<EOL
node_ping_gateway_ms gauge{gw="$gw",stat="min"}  $min
node_ping_gateway_ms gauge{gw="$gw",stat="avg"}  $avg
node_ping_gateway_ms gauge{gw="$gw",stat="max"}  $max
node_ping_gateway_ms gauge{gw="$gw",stat="mdev"} $mdev
EOL
            }
            ;;
    esac
}

collect_metrics() {
    node_network_xrate_bytes
    node_ping_gateway_ms
    node_cpu_temperature_c
    node_cpu_frequency_khz
    node_cpu_usage_overall
    node_cpu_usage_process
}

transpose() {
    if $SHOW_HEADER; then
        SHOW_HEADER=false
        tee >(awk '{print $2}'| tr '\n' ' ';echo) > >(awk '{print $1}'| tr '\n' ' '; echo)
    else
        awk '{print $2}'| tr '\n' ' '
        echo
    fi
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

branch=$(git branch --show-current)
test $branch == 'master' || { exit 1; }

while getopts ":f:h" opt
do
    case $opt in
        f) case $OPTARG in
               $OUTPUT_SHELL|$OUTPUT_PROM) OUTPUT_FORMAT=$OPTARG ;;
               *) err "unknow format '$OPTARG'"; exit 1 ;;
           esac
           ;;
        h) usage; exit 0;;
    esac
done

while sleep $RUN_INTERVAL; do
    case $OUTPUT_FORMAT in
        $OUTPUT_SHELL)
            collect_metrics | transpose # need shopt -s lastpipe
            ;;
        $OUTPUT_PROM)
            collect_metrics
            ;;
    esac
done

exit 0
