#!/bin/bash

PROFILE_ID=$1

# remove routes pushed from OpenVPN server due to redirect-gateway options
sudo ip route del 0.0.0.0/1 || true
sudo ip route del 128.0.0.0/1 || true

# remove IPv6 routes from main table
sudo ip -6 route flush dev $dev proto boot || true

# create file with vpn gateway IP and subnet
GATEWAY_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.gateway"
echo $route_vpn_gateway > $GATEWAY_FILE
chown pi $GATEWAY_FILE

GATEWAY6_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.gateway6"
echo ${ifconfig_ipv6_remote} > $GATEWAY6_FILE
chown pi $GATEWAY6_FILE

SUBNET_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.subnet"
echo -n "" > $SUBNET_FILE
for route_network_option_name in ${!route_network_*} ; do
  route_network="${!route_network_option_name}"
  route_netmask_option_name="route_netmask_$(echo $route_network_option_name | awk -F_ '{print $3}')"
  route_netmask="${!route_netmask_option_name}"
  echo "$route_network/$route_netmask" >> $SUBNET_FILE
done

chown pi $SUBNET_FILE

SUBNET6_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.subnet6"
echo -n "" > $SUBNET6_FILE
subnetwork6=$(ipcalc -nb $ifconfig_ipv6_local/$ifconfig_ipv6_netbits |awk '$1 == "Prefix:" {print $2}')
if [ -z "$subnetwork6" ]; then
  subnetwork6=$(python3 -c "import ipaddress; print(ipaddress.IPv6Network(u'${ifconfig_ipv6_local}/${ifconfig_ipv6_netbits}', strict=False).with_prefixlen)")
fi
echo "${subnetwork6}" >> $SUBNET6_FILE

for route_network_option_name in ${!route_ipv6_network_*}; do
  route_network="${!route_network_option_name}"
  echo "$route_network" >> $SUBNET6_FILE
done
chown pi $SUBNET6_FILE

IP4_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.ip4"
echo $ifconfig_local > $IP4_FILE
chown pi $IP4_FILE

IP6_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.ip6"
echo ${ifconfig_ipv6_local} > $IP6_FILE
chown pi $IP6_FILE

redis-cli publish "ovpn_client.route_up" "$PROFILE_ID"