#!/bin/bash

sudo bash -c "echo 8 > /proc/irq/28/smp_affinity"
sudo bash -c "echo 7 > /sys/class/net/eth0/queues/rx-0/rps_cpus"

# disable auth.log in rsyslog and remove existing one if any
sudo sed -i -e 's/^auth,authpriv/#auth,authpriv/' /etc/rsyslog.d/50-default.conf
sudo rm -f /var/log/auth.log