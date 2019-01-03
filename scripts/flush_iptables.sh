#!/bin/bash

# if the box is in dhcp mode, we want to keep DNAT/MASQUERADE rules alive as much as possible
# or user's internet connection will go dead

MODE=$(redis-cli get mode)
if [ "$MODE" = "dhcp" ]
then
  mapfile -t DNAT_RULES < <( sudo iptables -t nat -S | grep DNAT ) # Backup DNAT rules into DNAT_RULES as an array
  mapfile -t MASQ_RULES < <( sudo iptables -t nat -S | grep MASQUERADE )
  DHCP_RULES=("${DNAT_RULES[@]}" "${MASQ_RULES[@]}") # Merge 2 arrays
fi

sudo iptables -w -F
sudo iptables -w -F -t nat
sudo iptables -w -F -t raw
sudo ip6tables -w -F
sudo ip6tables -w -F -t nat
sudo ip6tables -w -F -t raw

if [ "$MODE" = "dhcp" ]
then
  for RULE in "${DHCP_RULES[@]}";
  do 
    sudo iptables -w -t nat $RULE
  done
fi
