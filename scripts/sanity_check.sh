#!/bin/bash

check_cloud() {
    echo -n "  checking cloud access ... "
    curl_result=$(curl -w '%{http_code}' -Lks --connect-timeout 5 https://firewalla.encipher.io)
    test $curl_result == '200' && echo OK || { echo "fail($curl_result)"; return 1; }
    return 0
}

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

check_git() {
    _rc=0
    repo_dir=$1
    remote_origin=$2
    echo -n "  check Git repository $repo_dir ... "
    pushd $repo_dir >/dev/null
    git_output=$(git status -uno --porcelain 2>&1)
    if [[ -n "$git_output" || $? -ne 0 ]]
    then
        echo fail
        _rc=1
    elif [[ $remote_origin != $(git remote -v | awk '/origin/ {print $2}' | uniq) ]]
    then
        echo fail
        _rc=1
    else
        echo OK
    fi
    popd >/dev/null
    return $_rc
}

rc=0

echo Start testing at $(date)

check_cloud || rc=1

check_process redis-server || rc=1
check_process FireMain || rc=1
check_process FireApi || rc=1
check_process FireMon || rc=1
check_process FireKick || rc=1

check_partition overlayroot || rc=1
check_partition /data || rc=1
check_partition /log || rc=1
check_zram || rc=1

check_git /home/pi/firewalla https://github.com/firewalla/firewalla.git
check_git /home/pi/.node_modules https://github.com/firewalla/fnm.node8.armv7l.git

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
