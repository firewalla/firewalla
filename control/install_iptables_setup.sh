#!/bin/bash

sudo which ipset &>/dev/null || sudo apt-get install -y ipset

sudo ipset create blocked_ip_set hash:ip family inet hashsize 128 maxelem 65536 &>/dev/null
sudo ipset create blocked_ip_port_set hash:ip,port family inet hashsize 128 maxelem 65536 &>/dev/null

# This is to ensure all ipsets are empty when initializing 
sudo ipset flush blocked_ip_set
sudo ipset flush blocked_ip_port_set


#FIXME: ignore if failed or not
sudo iptables -N FW_BLOCK
sudo iptables -F FW_BLOCK
sudo iptables -C FW_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN &>/dev/null || sudo iptables -A FW_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN
sudo iptables -C FW_BLOCK -p all -m set --match-set blocked_ip_set dst -j DROP &>/dev/null || sudo iptables -I FW_BLOCK -p all -m set --match-set blocked_ip_set dst -j DROP
sudo iptables -C FW_BLOCK -p all -m set --match-set blocked_ip_set src -j DROP &>/dev/null || sudo iptables -I FW_BLOCK -p all -m set --match-set blocked_ip_set src -j DROP
sudo iptables -C FW_BLOCK -p all -m set --match-set blocked_ip_port_set dst,dst -j DROP &>/dev/null || sudo iptables -I FW_BLOCK -p all -m set --match-set blocked_ip_port_set dst,dst -j DROP

sudo iptables -C FORWARD -p all -j FW_BLOCK &>/dev/null || sudo iptables -A FORWARD -p all -j FW_BLOCK


if [[ -e /.dockerenv ]]; then
  sudo iptables -C OUTPUT -p all -j FW_BLOCK &>/dev/null || sudo iptables -A OUTPUT -p all -j FW_BLOCK
fi

if [[ -e /sbin/ip6tables ]]; then

  sudo ipset create blocked_ip_set6 hash:ip family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset create blocked_ip_port_set6 hash:ip,port family inet6 hashsize 128 maxelem 65536 &>/dev/null
  sudo ipset flush blocked_ip_set6
  sudo ipset flush blocked_ip_port_set6

  
  sudo ip6tables -N FW_BLOCK
  sudo ip6tables -F FW_BLOCK  
  sudo ip6tables -C FW_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN &>/dev/null ||   sudo ip6tables -A FW_BLOCK -p all --source 0.0.0.0/0 --destination 0.0.0.0/0 -j RETURN
  sudo ip6tables -C FW_BLOCK -p all -m set --match-set blocked_ip_set6 dst -j DROP &>/dev/null ||   sudo ip6tables -I FW_BLOCK -p all -m set --match-set blocked_ip_set6 dst -j DROP
  sudo ip6tables -C FW_BLOCK -p all -m set --match-set blocked_ip_set6 src -j DROP &>/dev/null ||   sudo ip6tables -I FW_BLOCK -p all -m set --match-set blocked_ip_set6 src -j DROP
  sudo ip6tables -C FW_BLOCK -p all -m set --match-set blocked_ip_port_set6 dst,dst -j DROP &>/dev/null ||   sudo ip6tables -I FW_BLOCK -p all -m set --match-set blocked_ip_port_set6 dst,dst -j DROP  
  sudo ip6tables -C FORWARD -p all -j FW_BLOCK &>/dev/null ||   sudo ip6tables -A FORWARD -p all -j FW_BLOCK
fi


