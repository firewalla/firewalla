#!/bin/bash

# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------

CMD=$(basename $0)
CMDDIR=$(dirname $0)

# ----------------------------------------------------------------------------
# Function
# ----------------------------------------------------------------------------

usage() {
    cat <<EOU
usage: $CMD [<profile_path>]
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
        echo $smp_affinity > /proc/irq/$irq/smp_affinity
    done
}

set_rps_cpus() {
    while read intf q rps_cpus
    do
        echo $rps_cpus > /sys/class/net/$intf/queues/$q/rps_cpus
    done
}

do_taskset() {
    while read pname cpu_list
    do
        loginfo "do_task $pname $cpu_list"
        pid=$(pidof $pname)
        test -n "$pid" && taskset -cp $cpu_list $pid
    done
}

set_cpufreq() {
    while read min max governor
    do
        cat <<EOS > /etc/default/cpufrequtils
ENABLE=true
MIN_SPEED=${min}
MAX_SPEED=${max}
GOVERNOR=${governor}
EOS
        systemctl reload cpufrequtils
    done
}

set_priority() {
    while read pname nvalue
    do
        pid=$(pidof $pname)
        test -n "$pid" && renice -n $nvalue -p $pid
    done

}

apply_profile() {
    _rc=0
    input_json=$(cat)
    for key in $(echo "$input_json"| jq -r 'keys[]')
    do
        loginfo "apply key '$key'"
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

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

test $UID -eq 0 || {
    logerror 'Must run with root privilege'
    exit 1
}

test $# -gt 0 ||{
    usage
    exit 1
}

profile_path=${1:-''}
rc=0


cat $profile_path | apply_profile || {
    logerror "failed to apply profile"
    rc=1
}

exit $rc