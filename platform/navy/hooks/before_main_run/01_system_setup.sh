#!/bin/bash

sudo bash -c "echo 8 > /proc/irq/28/smp_affinity"
sudo bash -c "echo 7 > /sys/class/net/eth0/queues/rx-0/rps_cpus"
