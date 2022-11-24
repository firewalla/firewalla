#!/bin/bash

NUM=${1:-'1'}

test $NUM -gt 10 && exit 0

if [[ $NUM -eq 1 ]]; then
    time_bt=$(dmesg -T | sed -n '/ CSR8510 / s/\[\(.*\)\].*/\1/p'|tail -1)
    if [[ -n "$time_bt" ]]; then
        time_now_s=$(date +%s)
        time_bt_s=$(date -d "$time_bt" +%s)
        let time_diff=time_now_s-time_bt_s
        # NO beep if bluetooth inserted more than 30 seconds ago
        test $time_diff -gt 30 && exit 1
    else
        # NO beep if bluetooth line NOT found in dmesg, which means it was not touched so long that dmesg log got rotated
        exit 1
    fi
fi

test $(redis-cli type sys:nobeep) != "none" && redis-cli del sys:nobeep && exit 0

sudo modprobe pcspkr
sudo su -l root -c "beep -r $NUM"
sudo rmmod pcspkr
