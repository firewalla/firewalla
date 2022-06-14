#!/usr/bin/env bash

set_fan() {
    echo $1 > /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1_enable
    echo $2 > /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1
}

if [[ $(cat /sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1_enable) -ne 2 ]]; then
    set_fan 2 0
fi
