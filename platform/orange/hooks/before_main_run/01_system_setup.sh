#!/bin/bash

sudo bash -c "echo 1 > /sys/class/hwmon/hwmon0/pwm1_mode"

# disable auth.log in rsyslog and remove existing one if any
sudo sed -i -e 's/^auth,authpriv/#auth,authpriv/' /etc/rsyslog.d/50-default.conf
sudo rm -f /var/log/auth.log
