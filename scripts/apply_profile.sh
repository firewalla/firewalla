#!/bin/bash

# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------

CMD=$(basename $0)
CMDDIR=$(dirname $0)
FIREWALLA_HOME=$(cd $CMDDIR; git rev-parse --show-toplevel)
: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${PROFILE_CHECK:=false}
source ${FIREWALLA_HOME}/platform/platform.sh
PROFILE_DEFAULT_DIR=$FIREWALLA_HOME/platform/$FIREWALLA_PLATFORM/profile
PROFILE_DEFAULT_NAME=$(get_profile_default_name)
PROFILE_USER_DIR=/home/pi/.firewalla/run/profile

# ----------------------------------------------------------------------------
# Function
# ----------------------------------------------------------------------------

usage() {
    cat <<EOU
usage: $CMD [-n] [<active_profile_path>]
options:

    -n
        No actual operation but checking.
EOU
}

mylog() {
    echo "$(date):$@"
}

loginfo() {
    mylog "INFO: $@"
}

logerror() {
    mylog "ERROR:$@" >&2
}

set_nic_feature() {
    while read nic k v
    do
        ethtool -K $nic $k $v
    done
}

set_smp_affinity() {
    while read intf smp_affinity
    do
        for irq in $(cat /proc/interrupts | awk "\$NF == \"$intf\" {print \$1}"|tr -d :)
        do
            if $PROFILE_CHECK; then
                cat /proc/irq/$irq/smp_affinity
            else
                echo $smp_affinity > /proc/irq/$irq/smp_affinity
            fi
        done
    done
}

set_rps_cpus() {
    while read intf q rps_cpus
    do
        rps_cpus_paths=/sys/class/net/$intf/queues/$q/rps_cpus
        for rps_cpus_path in $rps_cpus_paths; do
            if $PROFILE_CHECK; then
                cat $rps_cpus_path
            else
                echo $rps_cpus > $rps_cpus_path
            fi
        done
    done
}

get_pids() {
    mode=$1
    pname=$2
    local pids=
    case $mode in
        match)
          pids=$(ps  -eo pid,cmd |grep "$pname" | grep -v grep | awk '{print $1}')
          ;;
        exact)
          pids=$(pidof $pname)
          ;;
        *)
          logerror "unknown mode '$mode'"
          ;;
    esac
    echo "$pids"
}

do_taskset() {
    while read pname cpu_list mode
    do
        loginfo "do_task $pname $cpu_list"
        pids=$(get_pids ${mode:='exact'} "$pname")
        for pid in $pids; do
            if $PROFILE_CHECK; then
                taskset -acp $pid
            else
                taskset -acp $cpu_list $pid
            fi
        done
    done
}

set_cpufreq() {
    read min max governor
    if $PROFILE_CHECK; then
        cpufreq-info |grep -A3 policy|sed '/--/q'
    else
        echo ${min} | tee /sys/devices/system/cpu/cpufreq/policy*/scaling_min_freq
        echo ${max} | tee /sys/devices/system/cpu/cpufreq/policy*/scaling_max_freq
        echo ${governor} | tee /sys/devices/system/cpu/cpufreq/policy*/scaling_governor
    fi
}

set_cpufreqs() {
    while read cpuid min max governor
    do
        if $PROFILE_CHECK; then
            cpufreq-info |grep -A3 policy
        else
            echo ${min} > /sys/devices/system/cpu/cpufreq/policy${cpuid}/scaling_min_freq
            echo ${max} > /sys/devices/system/cpu/cpufreq/policy${cpuid}/scaling_max_freq
            echo ${governor} > /sys/devices/system/cpu/cpufreq/policy${cpuid}/scaling_governor
        fi
    done
}

set_priority() {
    while read pname nvalue mode
    do
        pids=$(get_pids ${mode:='exact'} "$pname")
        for pid in $pids; do
            if $PROFILE_CHECK; then
                ps -l $pid
            else
                renice -n $nvalue -p $pid
            fi
        done
    done
}

set_sysctl() {
    while read pname pvalue
    do
        sudo sysctl -w "$pname=$pvalue"
    done
}

set_iplink() {
    while read intf pname pvalue
    do
        sudo ip link set $intf $pname $pvalue
    done
}

# examples
#
# "tc": [
#     [ "eth0", "default"]
#  - xor -
#     [ "eth0", "fq_codel"]
#  - xor -
#     [ "eth0", "htb", "rate", "500mbit"]
# ]
#
set_tc() {
    while read intf qdname pname pvalue
    do
        case $qdname in
            default)
                sudo tc qdisc del dev $intf root
                ;;
            fq_codel)
                sudo tc qdisc add dev $intf root fq_codel
                ;;
            htb)
                sudo tc qdisc replace dev $intf root handle 1: htb default 1
                sudo tc class add dev $intf parent 1: classid 1:1 htb prio 4 $pname $pvalue
                ;;
        esac
    done
}

process_profile() {
    _rc=0
    input_json=$(cat)
    for key in $(echo "$input_json"| jq -r 'keys[]')
    do
        loginfo "- process '$key'"

        test -n "$FW_PROFILE_KEY" && \
            test "$key" != "$FW_PROFILE_KEY" && \
            loginfo "- ignore key '$key', as only '$FW_PROFILE_KEY' is selected" && \
            continue

        case $key in
            nic_feature)
                echo "$input_json" | jq -r '.nic_feature[]|@tsv' | set_nic_feature
                ;;
            smp_affinity)
                echo "$input_json" | jq -r '.smp_affinity[]|@tsv' | set_smp_affinity
                ;;
            rps_cpus)
                echo "$input_json" | jq -r '.rps_cpus[]|@tsv' | set_rps_cpus
                ;;
            taskset)
                echo "$input_json" | jq -r '.taskset[]|@tsv' | do_taskset
                ;;
            cpufreq)
                echo "$input_json" | jq -r '.cpufreq|@tsv' | set_cpufreq
                ;;
            cpufreqs)
                vendor_id=$(lscpu | grep '^Vendor ID:' | awk '{print $3}')
                model=$(lscpu | grep '^Model:' | awk '{print $2}')
                key="$vendor_id:$model"
                if [[ $(echo "$input_json" | jq -r ".cpufreqs.\"$key\"") != "null" ]]; then
                    echo "$input_json" | jq -r ".cpufreqs.\"$key\"[]|@tsv" | set_cpufreqs
                else
                    echo "$input_json" | jq -r ".cpufreqs.default[]|@tsv" | set_cpufreqs
                fi
                ;;
            priority)
                echo "$input_json" | jq -r '.priority[]|@tsv' | set_priority
                ;;
            sysctl)
                echo "$input_json" | jq -r '.sysctl[]|@tsv' | set_sysctl
                ;;
            iplink)
                echo "$input_json" | jq -r '.iplink[]|@tsv' | set_iplink
                ;;
            tc)
                echo "$input_json" | jq -r '.tc[]|@tsv' | set_tc
                ;;
            *)
                echo "unknown key '$key'"
                _rc=1
                ;;
            
        esac
    done
    return $_rc
}

get_active_profile() {
    ap_name=$(redis-cli get platform:profile:active)
    if [[ -n "$ap_name" ]]; then
        ap=$PROFILE_USER_DIR/$ap_name
        test -e $ap || ap=$PROFILE_DEFAULT_DIR/$ap_name
    else
        ap=$PROFILE_DEFAULT_DIR/$PROFILE_DEFAULT_NAME
    fi
    echo $ap
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

logger "FIREWALLA:APPLY_PROFILE:START"

test $UID -eq 0 || {
    logerror 'Must run with root privilege'
    exit 1
}

rc=0

while getopts ":n" opt
do
    case $opt in
        h) usage ; exit 0 ;;
        n) PROFILE_CHECK=true;;
    esac
done
shift $((OPTIND-1))

active_profile=${1:-$(get_active_profile)}
loginfo "Process profile - $active_profile"
cat $active_profile | process_profile || {
    logerror "failed to process profile"
    rc=1
}

logger "FIREWALLA:APPLY_PROFILE:DONE"

exit $rc
