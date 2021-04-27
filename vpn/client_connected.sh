#!/bin/bash

CLIENT_RC="/home/pi/ovpns/$common_name/$common_name.rc"

if [[ -f $CLIENT_RC ]]; then
  source "$CLIENT_RC"
fi

INSTANCE=$1
PTP_ADDR=`cat /etc/openvpn/ovpn_server/$INSTANCE.gateway`

if [[ -n $CLIENT_SUBNETS ]]; then # CLIENT_SUBNETS are cidr subnets separated with comma
  CLIENT_SUBNETS=${CLIENT_SUBNETS//,/ } # replace comma with space
  for CLIENT_SUBNET in $CLIENT_SUBNETS;
  do
    sudo ip r add $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn table lan_routable || true
    sudo ip r add $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn table wan_routable || true
    sudo ip r add $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn || true
  done
fi