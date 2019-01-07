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
mapfile -t VPN_RULES < <( sudo iptables -w -t nat -S | grep POSTROUTING | grep SNAT )


sudo iptables -w -F
sudo iptables -w -F -t nat
sudo iptables -w -F -t raw
sudo ip6tables -w -F
sudo ip6tables -w -F -t nat
sudo ip6tables -w -F -t raw


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
