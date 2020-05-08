#!/bin/bash

# if the box is in dhcp mode, we want to keep MASQUERADE rule alive as much as possible
# or user's internet connection will go dead
# DNAT rules are free to flush as they won't block internet
MODE=$(redis-cli get mode)
if [ "$MODE" = "dhcp" ]
then
  # reading filtered rules into an array https://www.computerhope.com/unix/bash/mapfile.htm
  mapfile -t DHCP_RULES < <( sudo iptables -w -t nat -S | grep MASQUERADE )
fi

# Same situation applies to VPN connection
mapfile -t VPN_RULES < <( sudo iptables -w -t nat -S | grep FW_POSTROUTING | grep SNAT )

if [[ $(uname -m) == "x86_64" ]]; then
  sudo iptables -w -t mangle -N FW_PREROUTING &>/dev/null
  sudo iptables -w -t mangle -F FW_PREROUTING
  sudo iptables -w -t nat -N FW_PREROUTING &>/dev/null
  sudo iptables -w -t nat -F FW_PREROUTING
  sudo iptables -w -t nat -N FW_POSTROUTING &>/dev/null
  sudo iptables -w -t nat -F FW_POSTROUTING
  sudo iptables -w -N FW_FORWARD &>/dev/null
  sudo iptables -w -F FW_FORWARD
    
  sudo ip6tables -w -t mangle -N FW_PREROUTING &>/dev/null
  sudo ip6tables -w -t mangle -F FW_PREROUTING
  sudo ip6tables -w -t nat -N FW_PREROUTING &>/dev/null
  sudo ip6tables -w -t nat -F FW_PREROUTING
  sudo ip6tables -w -t nat -N FW_POSTROUTING &>/dev/null
  sudo ip6tables -w -t nat -F FW_POSTROUTING
  sudo ip6tables -w -N FW_FORWARD &>/dev/null
  sudo ip6tables -w -F FW_FORWARD
else
  # TODO: this if-else is a workaround. It should be changed after the first release.
  #       Then all the platform should use commands in if clause 
  sudo iptables -w -t raw -F
  sudo iptables -w -t mangle -F
  sudo iptables -w -t nat -F
  sudo iptables -w -t filter -F
  sudo iptables -w -t mangle -N FW_PREROUTING &>/dev/null
  sudo iptables -w -t nat -N FW_PREROUTING &>/dev/null
  sudo iptables -w -t nat -N FW_POSTROUTING &>/dev/null
  sudo iptables -w -N FW_FORWARD &>/dev/null
  
  sudo ip6tables -w -t raw -F
  sudo ip6tables -w -t mangle -F
  sudo ip6tables -w -t nat -F
  sudo ip6tables -w -t filter -F
  sudo ip6tables -w -t mangle -N FW_PREROUTING &>/dev/null
  sudo ip6tables -w -t nat -N FW_PREROUTING &>/dev/null
  sudo ip6tables -w -t nat -N FW_POSTROUTING &>/dev/null
  sudo ip6tables -w -N FW_FORWARD &>/dev/null
fi

for RULE in "${VPN_RULES[@]}";
do
  sudo iptables -w -t nat $RULE
done

if [ "$MODE" = "dhcp" ]
then
  for RULE in "${DHCP_RULES[@]}";
  do 
    sudo iptables -w -t nat $RULE
  done
fi
