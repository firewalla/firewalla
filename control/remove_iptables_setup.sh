#!/bin/bash

sudo iptables -w -D FW_FORWARD -p all -j FW_BLOCK
sudo iptables -w -F FW_BLOCK
sudo iptables -w -X FW_BLOCK

if which ip6tables; then
  sudo iptables -w -D FW_FORWARD -p all -j FW_BLOCK
  sudo iptables -w -F FW_BLOCK
  sudo iptables -w -X FW_BLOCK
fi

sudo ipset del -! blocked_ip_set
