#!/bin/bash

sudo which ipset &>/dev/null || sudo apt-get install -y ipset

sudo ipset create blocked_ip_set hash:ip family inet hashsize 128 maxelem 65536

#FIXME: ignore if failed or not
sudo iptables -N FW_BLOCK
sudo iptables -F FW_BLOCK
sudo iptables -A FW_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN
sudo iptables -I FW_BLOCK -p all -m set --match-set blocked_ip_set dst -j DROP

sudo iptables -A FORWARD -p all -j FW_BLOCK

if which ip6tables; then
  sudo ip6tables -N FW_BLOCK
  sudo ip6tables -F FW_BLOCK  
  sudo ip6tables -A FW_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN
  sudo ip6tables -I FW_BLOCK -p all -m set --match-set blocked_ip_set dst -j DROP  
  sudo ip6tables -A FORWARD -p all -j FW_BLOCK
fi


