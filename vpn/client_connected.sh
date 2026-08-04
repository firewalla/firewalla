#!/bin/bash

CLIENT_RC="/home/pi/ovpns/$common_name/$common_name.rc"

if [[ -f $CLIENT_RC ]]; then
  source "$CLIENT_RC"
fi

INSTANCE=$1
PTP_ADDR=`cat /etc/openvpn/ovpn_server/$INSTANCE.gateway`

LOCK_FILE=/var/lock/ovpn_server_update_rt
exec {lock_fd}> $LOCK_FILE
flock -x -w 5 $lock_fd || {
  echo "cannot acquire ovpn_server_update_rt lock on client-connected"
  exit 1
}

if [[ -n $CLIENT_SUBNETS ]]; then # CLIENT_SUBNETS are cidr subnets separated with comma
  CLIENT_SUBNETS=${CLIENT_SUBNETS//,/ } # replace comma with space
  for CLIENT_SUBNET in $CLIENT_SUBNETS;
  do
    sudo ip r add $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn table lan_routable metric 1024 || true
    sudo ip r add $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn table wan_routable metric 1024 || true
    sudo ip r add $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn metric 1024 || true
  done
fi

redis-cli publish "ovpn.client_connected" "$common_name,$trusted_ip,$trusted_ip6,$trusted_port,$ifconfig_pool_remote_ip,$ifconfig_pool_remote_ip6,$dev"