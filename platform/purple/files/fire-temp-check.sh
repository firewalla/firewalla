#!/usr/bin/env bash

set_value() {
    if [[ $(cat /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1_enable) -ne $1 ]]; then
        echo $1 | sudo tee /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1_enable
    fi

    if [[ $(cat /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1) -ne $2 ]]; then
        echo $2 | sudo tee /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1
    fi
}

MODE=$(redis-cli get sys:bone:info | jq -r .cloudConfig.fireTempCheck.mode 2>/dev/null)
LOW=$(redis-cli get sys:bone:info | jq -r .cloudConfig.fireTempCheck.low 2>/dev/null)
HIGH=$(redis-cli get sys:bone:info | jq -r .cloudConfig.fireTempCheck.high 2>/dev/null)
NUM=$(redis-cli get sys:bone:info | jq -r .cloudConfig.fireTempCheck.num 2>/dev/null)

test "$LOW" == "null" && LOW=67
test "$HIGH" == "null" && HIGH=73
test "$NUM" == "null" && NUM=1

CURRENT=$(cat /sys/class/thermal/thermal_zone0/temp)

if [[ "x$MODE" == "x1" ]]; then
    if ((  CURRENT > HIGH * 1000 )); then
        set_value 1 175
    elif (( CURRENT < LOW * 1000 )); then
        set_value 1 0
        for i in $(seq 1 $NUM); do
            echo "for(;;){}" | timeout 59 sudo -u pi /home/pi/firewalla/bin/node &
        done
    else
        set_value 1 0
    fi
elif [[ "x$MODE" == "x2" ]]; then
    set_value 2 0
fi


