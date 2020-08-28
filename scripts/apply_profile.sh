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
        rps_cpus_path=/sys/class/net/$intf/queues/$q/rps_cpus
        test -e $rps_cpus_path || continue
        if $PROFILE_CHECK; then
            cat $rps_cpus_path
        else
            echo $rps_cpus > $rps_cpus_path
        fi
    done
}

do_taskset() {
    while read pname cpu_list
    do
        loginfo "do_task $pname $cpu_list"
        pid=$(pidof $pname)
        if [[ -n "$pid" ]]; then
            if $PROFILE_CHECK; then
                taskset -cp $pid
            else
                taskset -cp $cpu_list $pid
            fi
        fi
    done
}

set_cpufreq() {
    read min max governor
    if $PROFILE_CHECK; then
        cat /etc/default/cpufrequtils
    else
        cat <<EOS > /etc/default/cpufrequtils
ENABLE=true
MIN_SPEED=${min}
MAX_SPEED=${max}
GOVERNOR=${governor}
EOS
        systemctl reload cpufrequtils
    fi
}

set_priority() {
    while read pname nvalue
    do
        pid=$(pidof $pname)
        if $PROFILE_CHECK; then
            ps -l $pid
        else
            test -n "$pid" && renice -n $nvalue -p $pid
        fi
    done

}

apply_profile() {
    _rc=0
    input_json=$(cat)
    for key in $(echo "$input_json"| jq -r 'keys[]')
    do
        loginfo "- apply '$key'"
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
loginfo "Apply profile - $active_profile"
cat $active_profile | apply_profile || {
    logerror "failed to apply profile"
    rc=1
}

exit $rc
