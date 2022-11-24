#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

if [[ $MANAGED_BY_FIREROUTER != "yes" ]]; then
  sudo sysctl net.netfilter.nf_conntrack_helper=1
  sudo modprobe ip_nat_pptp
fi