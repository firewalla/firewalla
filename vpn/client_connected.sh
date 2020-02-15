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
    sudo ip r add $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn
  done
fi
# If above add route command fails, usually due to the route already exists, this scripts will return non-zero exit value. The client will not be able to connect.
# This is an expected behavior since only one client with the same common name is allowed to connect at the same time. Script client_disconnected.sh will remove the route when client is disconnected.