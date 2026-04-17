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
BYPASS_SUBNET_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.subnet_bypass"
echo -n "" > $SUBNET_FILE
echo -n "" > "$BYPASS_SUBNET_FILE"

for route_network_option_name in ${!route_network_*} ; do
  route_network="${!route_network_option_name}"
  route_idx=$(echo $route_network_option_name | awk -F_ '{print $3}')
  route_netmask_option_name="route_netmask_${route_idx}"
  route_netmask="${!route_netmask_option_name}"
  route_gateway_option_name="route_gateway_${route_idx}"
  route_gateway="${!route_gateway_option_name}"
  # routes with a gateway other than vpn gateway should go through ISP
  # write them to bypass file so throw routes can be added to the VPN routing table
  # config without gateway_option will not be filtered.
  if [ -n "$route_gateway" ] && [ "$route_gateway" != "$route_vpn_gateway" ]; then
    echo "$route_network/$route_netmask" >> "$BYPASS_SUBNET_FILE"
    continue
  fi
  echo "$route_network/$route_netmask" >> "$SUBNET_FILE"
done

chown pi "$SUBNET_FILE"
chown pi "$BYPASS_SUBNET_FILE"

SUBNET6_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.subnet6"
BYPASS_SUBNET6_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.subnet6_bypass"
echo -n "" > "$SUBNET6_FILE"
echo -n "" > "$BYPASS_SUBNET6_FILE"
subnetwork6=$(ipcalc -nb $ifconfig_ipv6_local/$ifconfig_ipv6_netbits |awk '$1 == "Prefix:" {print $2}')
if [ -z "$subnetwork6" ]; then
  subnetwork6=$(python3 -c "import ipaddress; print(ipaddress.IPv6Network(u'${ifconfig_ipv6_local}/${ifconfig_ipv6_netbits}', strict=False).with_prefixlen)")
fi
echo "${subnetwork6}" >> "$SUBNET6_FILE"

for route_network_option_name in ${!route_ipv6_network_*}; do
  route_network="${!route_network_option_name}"
  route_idx=$(echo $route_network_option_name | awk -F_ '{print $4}')
  route_gateway_option_name="route_ipv6_gateway_${route_idx}"
  route_gateway="${!route_gateway_option_name}"
  # routes with a gateway other than vpn gateway should go through ISP
  # write them to bypass file so throw routes can be added to the VPN routing table
  # config without gateway_option will not be filtered.
  if [ -n "$route_gateway" ] && [ "$route_gateway" != "$ifconfig_ipv6_remote" ]; then
    echo "$route_network" >> "$BYPASS_SUBNET6_FILE"
    continue
  fi
  echo "$route_network" >> "$SUBNET6_FILE"
done

chown pi "$SUBNET6_FILE"
chown pi "$BYPASS_SUBNET6_FILE"

IP4_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.ip4"
echo $ifconfig_local > $IP4_FILE
chown pi $IP4_FILE

IP6_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.ip6"
echo ${ifconfig_ipv6_local} > $IP6_FILE
chown pi $IP6_FILE

redis-cli publish "ovpn_client.route_up" "$PROFILE_ID"