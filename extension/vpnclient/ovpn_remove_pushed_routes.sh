#!/bin/bash

# remove routes pushed from OpenVPN server due to redirect-gateway options
sudo ip route del 0.0.0.0/1 || true
sudo ip route del 128.0.0.0/1 || true

# flush IPv6 address
sudo ip -6 a flush dev $dev || true

# create file with vpn gateway IP and subnet
PROFILE_ID=$1

GATEWAY_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.gateway"
echo $route_vpn_gateway > $GATEWAY_FILE
chown pi $GATEWAY_FILE

SUBNET_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.subnet"
echo -n "" > $SUBNET_FILE
for route_network_option_name in ${!route_network_*} ; do
  route_network="${!route_network_option_name}"
  route_netmask_option_name="route_netmask_$(echo $route_network_option_name | awk -F_ '{print $3}')"
  route_netmask="${!route_netmask_option_name}"
  echo "$route_network/$route_netmask" >> $SUBNET_FILE
done

chown pi $SUBNET_FILE

IP4_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.ip4"
echo $ifconfig_local > $IP4_FILE
chown pi $IP4_FILE

redis-cli publish "ovpn_client.route_up" "$PROFILE_ID"