#!/bin/bash

CLIENT_RC="/home/pi/ovpns/$common_name/$common_name.rc"

if [[ -f $CLIENT_RC ]]; then
  source "$CLIENT_RC"
fi

PTP_ADDR=`ifconfig | grep '^tun_fwvpn' -A 2 | grep 'P-t-P' | awk '{print $3}' | cut -d: -f2`

if [[ -n $CLIENT_SUBNETS ]]; then # CLIENT_SUBNETS are cidr subnets separated with comma
  CLIENT_SUBNETS=${CLIENT_SUBNETS//,/ } # replace comma with space
  for CLIENT_SUBNET in $CLIENT_SUBNETS;
  do
    sudo ip r del $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn
  done
fi

exit 0