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
PROFILE_DEFAULT_NAME=profile_default
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

set_smp_affinity() {
    while read intf smp_affinity
    do
        irq=$(cat /proc/interrupts | awk "\$NF == \"$intf\" {print \$1}"|tr -d :)
        if $PROFILE_CHECK; then
            cat /proc/irq/$irq/smp_affinity
        else
            echo $smp_affinity > /proc/irq/$irq/smp_affinity
        fi
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
        cpufreq-set -d ${min}
        cpufreq-set -u ${max}
        cpufreq-set -g ${governor}
    fi
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

process_profile() {
    _rc=0
    input_json=$(cat)
    for key in $(echo "$input_json"| jq -r 'keys[]')
    do
        loginfo "- process '$key'"
        case $key in
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
            priority)
                echo "$input_json" | jq -r '.priority[]|@tsv' | set_priority
                ;;
            sysctl)
                echo "$input_json" | jq -r '.sysctl[]|@tsv' | set_sysctl
                ;;
            iplink)
                echo "$input_json" | jq -r '.iplink[]|@tsv' | set_iplink
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

exit $rc
