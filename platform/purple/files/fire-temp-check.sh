#!/usr/bin/env bash

try_set_value() {
    if [[ "$(cat $1)" -ne $2 ]]; then
        echo $2 | sudo tee $1 &>/dev/null
    fi
}

set_value() {
    try_set_value /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1_enable $1
    try_set_value /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1 $2
}

set_cpu() {
    try_set_value /sys/devices/system/cpu/cpufreq/policy0/scaling_min_freq "${1}000"
    try_set_value /sys/devices/system/cpu/cpufreq/policy0/scaling_max_freq "${2}000"
    try_set_value /sys/devices/system/cpu/cpufreq/policy2/scaling_min_freq "${3}000"
    try_set_value /sys/devices/system/cpu/cpufreq/policy2/scaling_max_freq "${4}000"
}

MODE=$(redis-cli get sys:bone:info | jq -r .cloudConfig.fireTempCheck.mode 2>/dev/null)
BOTTOM=$(redis-cli get sys:bone:info | jq -r .cloudConfig.fireTempCheck.bottom 2>/dev/null)
LOW=$(redis-cli get sys:bone:info | jq -r .cloudConfig.fireTempCheck.low 2>/dev/null)
HIGH=$(redis-cli get sys:bone:info | jq -r .cloudConfig.fireTempCheck.high 2>/dev/null)
NUM=$(redis-cli get sys:bone:info | jq -r .cloudConfig.fireTempCheck.num 2>/dev/null)

BOTTOM=${BOTTOM:=43}
LOW=${LOW:=67}
HIGH=${HIGH:=76}
NUM=${NUM:=2}

test "$BOTTOM" == "null" && BOTTOM=43
test "$LOW" == "null" && LOW=67
test "$HIGH" == "null" && HIGH=76
test "$NUM" == "null" && NUM=2

CURRENT=$(cat /sys/class/thermal/thermal_zone0/temp)

if [[ "x$MODE" == "x1" ]]; then
    if ((  CURRENT > HIGH * 1000 )); then
        set_value 1 175
        set_cpu 1908 1908 2016 2016
    elif (( CURRENT < BOTTOM * 1000 )); then
        set_cpu 1908 1908 2208 2208
        set_value 1 0
        for i in $(seq 1 4); do
            echo "for(;;){}" | timeout 29 sudo -u pi nice -10 /home/pi/firewalla/bin/node &
        done
    elif (( CURRENT < LOW * 1000 )); then
        set_cpu 1908 1908 2208 2208
        set_value 1 0
        for i in $(seq 1 $NUM); do
            echo "for(;;){}" | timeout 29 sudo -u pi nice -10 /home/pi/firewalla/bin/node &
        done
    else
        set_cpu 1908 1908 2208 2208
        set_value 1 0
    fi
elif [[ "x$MODE" == "x2" ]]; then
    set_cpu 1000 1908 1000 2016
    set_value 2 0
fi

test -n "$INVOCATION_ID" && wait
