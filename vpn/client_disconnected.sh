#!/bin/bash

CLIENT_RC="/home/pi/ovpns/$common_name/$common_name.rc"

if [[ -f $CLIENT_RC ]]; then
  source "$CLIENT_RC"
fi

INSTANCE=$1
PTP_ADDR=`cat /etc/openvpn/ovpn_server/$INSTANCE.gateway`

function purge_rt() {
  LOCK_FILE=/var/lock/ovpn_server_update_rt
  exec {lock_fd}> $LOCK_FILE
  flock -x -w 5 $lock_fd || {
    echo "cannot acqire ovpn_server_update_rt lock on client-disconnected"
    return 1
  }
  echo status | nc localhost 5194 -q 0 -w 3 | awk '/^Common Name/{f=1;next} /^ROUTING TABLE/{f=0} f' | grep "^$common_name" &>/dev/null
  if [[ $? -ne 0 ]]; then
    echo "no more connections from $common_name, will purge its routing table entries ..."
    if [[ -n $CLIENT_SUBNETS ]]; then # CLIENT_SUBNETS are cidr subnets separated with comma
      CLIENT_SUBNETS=${CLIENT_SUBNETS//,/ } # replace comma with space
      for CLIENT_SUBNET in $CLIENT_SUBNETS;
      do
        sudo ip r del $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn metric 1024
        sudo ip r del $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn table lan_routable metric 1024 || true
        sudo ip r del $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn table wan_routable metric 1024 || true
      done
    fi
  else
    echo "still other connections from $common_name, its routing table entries will be retained"
  fi
}

purge_rt &

exit 0