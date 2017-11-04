#!/bin/bash

check_process() {
    echo -n "  checking process $1 ... "
    ps -ef | grep -w $1 | grep -qv grep && echo OK || { echo fail; return 1; }
    return 0
}

check_partition() {
    echo -n "  checking partition $1 ... "
    mount | grep -qw $1 && echo OK || { echo fail; return 1; }
    return 0
}

check_zram() {
    echo -n "  checking zram ... "
    test $(swapon -s | wc -l) -eq 5 && echo OK || { echo fail; return 1; }
    return 0
}

check_file() {
    echo -n "  check file $1 ... "
    if [[ -n "$2" ]]
    then
        grep -q "$2" $1 && echo OK || { echo fail; return 1; }
    else
        test -f $1 && echo OK || { echo fail; return 1; }
    fi
    return 0
}

rc=0

echo Start testing at $(date)

check_process redis-server || rc=1
check_process FireMain || rc=1
check_process FireApi || rc=1
check_process FireMon || rc=1
check_process FireKick || rc=1

check_partition overlayroot || rc=1
check_partition /data || rc=1
check_partition /log || rc=1
check_zram || rc=1

#check_file /encipher.config/license || rc=1
check_file ~/.forever/main.log || rc=1
check_file ~/.forever/api.log || rc=1
check_file ~/.forever/kickui.log || rc=1
check_file ~/.forever/monitor.log || rc=1
check_file /encipher.config/netbot.config || rc=1
check_file /sys/block/mmcblk0/device/serial || rc=1
check_file /sbin/iptables || rc=1
check_file /usr/bin/redis-server || rc=1

if [[ $rc -eq 0 ]]; then
    echo Santiy test PASSED
else
    echo Santiy test FAILED
fi

exit $rc
