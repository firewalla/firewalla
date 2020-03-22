#!/bin/bash

if [[ $(uname -m) != "x86_64" ]]; then
  sudo sysctl net.netfilter.nf_conntrack_helper=1
  sudo modprobe ip_nat_pptp
fi