#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

if [[ $IFB_SUPPORTED == "yes" ]]; then
  sudo modprobe ifb &> /dev/null || true
  # Kernel 6.6+ loads ifb but no longer auto-creates ifb0/ifb1; create them explicitly.
  if ! ip link show dev ifb0 &>/dev/null; then
    sudo ip link add ifb0 type ifb &>/dev/null || true
  fi
  if ! ip link show dev ifb1 &>/dev/null; then
    sudo ip link add ifb1 type ifb &>/dev/null || true
  fi
  sudo ip link set ifb0 up &>/dev/null || true
  sudo ip link set ifb1 up &>/dev/null || true
  sudo ip link add ifb_pcap_tap type ifb &>/dev/null || true
  sudo ip link set ifb_pcap_tap up &>/dev/null || true
else
  sudo rmmod ifb &> /dev/null || true
fi

if ip link show dev ifb0 >/dev/null; then
  sudo tc filter delete dev ifb0 &> /dev/null || true
  sudo tc qdisc delete dev ifb0 root &> /dev/null || true
  sudo ip link set ifb0 up
  sudo tc filter del dev ifb0 &> /dev/null || true
  sudo tc qdisc replace dev ifb0 root handle 1: htb default 1
  # 50 is the default priority
  sudo tc class add dev ifb0 parent 1: classid 1:1 htb rate 10240mbit prio 4
  sudo tc qdisc replace dev ifb0 parent 1:1 fq_codel
fi

if ip link show dev ifb1 >/dev/null; then
  sudo tc filter delete dev ifb1 &> /dev/null || true
  sudo tc qdisc delete dev ifb1 root &> /dev/null || true
  sudo ip link set ifb1 up
  sudo tc filter del dev ifb1 &> /dev/null || true
  sudo tc qdisc replace dev ifb1 root handle 1: htb default 1
  sudo tc class add dev ifb1 parent 1: classid 1:1 htb rate 10240mbit prio 4
  sudo tc qdisc replace dev ifb1 parent 1:1 fq_codel
fi