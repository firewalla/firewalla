#!/bin/bash

sudo iptables -D FORWARD -p all -j FW_BLOCK
sudo iptables -F FW_BLOCK
sudo iptables -X FW_BLOCK

if which ip6tables; then
  sudo iptables -D FORWARD -p all -j FW_BLOCK
  sudo iptables -F FW_BLOCK
  sudo iptables -X FW_BLOCK
fi

sudo ipset del -! blocked_ip_set
