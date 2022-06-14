#!/usr/bin/env bash

set_fan() {
    echo $1 | sudo tee /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1_enable
    echo $2 | sudo tee /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1
}

set_fan_to_target() {
    if [[ $(cat /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1) -ne $1 ]]; then
        echo $1 | sudo tee /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1
    fi
}

if [[ $(cat /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1_enable) -ne 1 ]]; then
    set_fan 1 0
fi

TEMP_LOW=${1:-67}
TEMP_HIGH=${2:-73}

temp_current=$(cat /sys/class/thermal/thermal_zone0/temp)

if (( temp_current > TEMP_HIGH * 1000 )); then
    set_fan_to_target 175
elif (( temp_current < TEMP_LOW * 1000 )); then
    set_fan_to_target 0
    stress -c 1 -t 60 &
else
    set_fan_to_target 0
fi
