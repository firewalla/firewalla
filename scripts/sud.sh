#!/bin/bash
# This script is used to enter a SUD terminal to simulate network environment for a given device without having to access to the user device
# SUD => Simulate user device

: "${AUTOLOGOUT_TIMEOUT:=300}"

function cleanup {
  echo "Cleaning up..."
  sudo ip link del sud_box
  sudo ip netns del sud_ns
  #sudo brctl setfd $NETWORK_INTF 15
  echo "Done"
}

trap cleanup EXIT

# ip or mac
DEVICE=${1^^}

if [[ -z "$DEVICE" ]]; then
        echo "$0 <mac_or_ip>"
        exit 0
fi

RESOLVED_DEVICE=""

MAC_FROM_IPV4=$(redis-cli hget "host:ip4:$DEVICE" mac)
test -z $MAC_FROM_IPV4 || RESOLVED_DEVICE=$MAC_FROM_IPV4

MAC_FROM_IPV6=$(redis-cli hget "host:ip6:$DEVICE" mac)
test -z $MAC_FROM_IPV6 || RESOLVED_DEVICE=$MAC_FROM_IPV6

MAC_FROM_MAC=$(redis-cli hget "host:mac:$DEVICE" mac)
test -z $MAC_FROM_MAC || RESOLVED_DEVICE=$MAC_FROM_MAC

test -z "$RESOLVED_DEVICE" && echo "Not able to find a valid device with input $DEVICE" && exit 1

IP=$(redis-cli hget "host:mac:$RESOLVED_DEVICE" ipv4)

NETWORK_UUID=$(redis-cli hget "host:mac:$RESOLVED_DEVICE" intf)
test -z "$NETWORK_UUID" && echo "No network found for device $RESOLVED_DEVICE" && exit 2

NETWORK_INTF=$(redis-cli hget network:uuid:$NETWORK_UUID intf)
test -z "$NETWORK_INTF" && echo "No network intf found for device $RESOLVED_DEVICE" && exit 3

NETWORK_SUBNET=$(redis-cli hget network:uuid:$NETWORK_UUID ipv4Subnet)
NETWORK_IP=$(redis-cli hget network:uuid:$NETWORK_UUID ipv4)

NETWORK_SUD_SUBNET=${NETWORK_SUBNET/$NETWORK_IP/$IP}

STP=$(brctl show br0 | awk '$1 == "br0" {print $3}')

echo "Device $DEVICE, IP: $IP, MAC: $RESOLVED_DEVICE, Network interface: $NETWORK_INTF, STP: $STP"

test "$STP" == "yes" && echo "Warning! STP is enabled on network $NETWORK_INTF, network access may be unavailable in the first few seconds"
sudo ip link add sud_box type veth peer name sud_device
sudo ip link set sud_box up
sudo ip link set sud_device up
sudo brctl setfd $NETWORK_INTF 5
sudo brctl addif $NETWORK_INTF sud_box
sudo ip netns add sud_ns
sudo ip link set sud_device netns sud_ns

SUD_PREFIX="sudo ip netns exec sud_ns"
$SUD_PREFIX ip link set sud_device up
$SUD_PREFIX ip link set sud_device address $RESOLVED_DEVICE
$SUD_PREFIX ip addr add $NETWORK_SUD_SUBNET dev sud_device
$SUD_PREFIX ip r add default via $NETWORK_IP dev sud_device

echo "Entering SUD terminal... (Use Ctrl+d or exit command to exit, this terminal will also auto logout if being idle more than $AUTOLOGOUT_TIMEOUT seconds)"
$SUD_PREFIX env TMOUT=$AUTOLOGOUT_TIMEOUT PS1="SUD $DEVICE> " /bin/bash --norc
