#!/bin/bash

if [[ -e /sys/class/hwmon/hwmon3/pwm1_auto_point2_pwm && -e /sys/class/hwmon/hwmon3/pwm1_auto_point1_temp ]]; then
  echo 45 | sudo tee pwm1_auto_point2_pwm
  echo 64000 | sudo tee pwm1_auto_point1_temp
fi

exit 0
