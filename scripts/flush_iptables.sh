#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

# Determine which IP families to process (default: both)
case "${1}" in
  4) IP_FAMILIES=(4) ;;
  6) IP_FAMILIES=(6) ;;
  *) IP_FAMILIES=(4 6) ;;
esac

# if the box is in dhcp mode, we want to keep MASQUERADE rule alive as much as possible
# or user's internet connection will go dead
# DNAT rules are free to flush as they won't block internet
if [[ " ${IP_FAMILIES[*]} " =~ " 4 " ]]; then
  MODE=$(redis-cli get mode)
  if [ "$MODE" = "dhcp" ] && [ "$MANAGED_BY_FIREROUTER" != "yes" ]; then
    # reading filtered rules into an array https://www.computerhope.com/unix/bash/mapfile.htm
    mapfile -t DHCP_RULES < <( sudo iptables -w -t nat -S | grep FW_POSTROUTING | grep MASQUERADE )
  fi

  # Same situation applies to VPN connection
  mapfile -t VPN_RULES < <( sudo iptables -w -t nat -S | grep FW_POSTROUTING | grep SNAT )
fi

source ${FIREWALLA_HOME}/scripts/fullfil_osi_ipset.sh
redis-cli SET osi:init:done true EX 60 &>/dev/null

for FAMILY in "${IP_FAMILIES[@]}"; do
  [ "$FAMILY" = "4" ] && IPT="iptables" || IPT="ip6tables"

  if [[ "$MANAGED_BY_FIREROUTER" == "yes" ]]; then
    sudo $IPT -w -t mangle -N FW_PREROUTING &>/dev/null
    sudo $IPT -w -t mangle -F FW_PREROUTING
    sudo $IPT -w -t mangle -N FW_FORWARD &>/dev/null
    sudo $IPT -w -t mangle -F FW_FORWARD
    sudo $IPT -w -t nat -N FW_PREROUTING &>/dev/null
    sudo $IPT -w -t nat -F FW_PREROUTING
    sudo $IPT -w -t nat -N FW_POSTROUTING &>/dev/null
    sudo $IPT -w -t nat -F FW_POSTROUTING
    sudo $IPT -w -N FW_FORWARD &>/dev/null
    sudo $IPT -w -F FW_FORWARD
  else
    # TODO: this if-else is a workaround. It should be changed after the first release.
    #       Then all the platform should use commands in if clause
    sudo $IPT -w -t raw -F
    sudo $IPT -w -t mangle -F
    sudo $IPT -w -t nat -F
    sudo $IPT -w -t filter -F
    sudo $IPT -w -t mangle -N FW_PREROUTING &>/dev/null
    sudo $IPT -w -t mangle -N FW_FORWARD &>/dev/null
    sudo $IPT -w -t nat -N FW_PREROUTING &>/dev/null
    sudo $IPT -w -t nat -N FW_POSTROUTING &>/dev/null
    sudo $IPT -w -N FW_FORWARD &>/dev/null
  fi
done

if [[ " ${IP_FAMILIES[*]} " =~ " 4 " ]]; then
  for RULE in "${VPN_RULES[@]}"; do
    sudo iptables -w -t nat $RULE
  done

  # no need to handle SNAT if it is managed by firerouter
  if [ "$MODE" = "dhcp" ] && [ "$MANAGED_BY_FIREROUTER" != "yes" ]; then
    for RULE in "${DHCP_RULES[@]}"; do
      sudo iptables -w -t nat $RULE
    done
  fi
fi
