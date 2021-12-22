#!/bin/bash

INSTANCE=$1

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

mkdir -p /etc/openvpn/ovpn_server

GATEWAY_FILE="/etc/openvpn/ovpn_server/$INSTANCE.gateway"
echo $route_vpn_gateway > $GATEWAY_FILE

SUBNET_FILE="/etc/openvpn/ovpn_server/$INSTANCE.subnet"
echo "${route_network_1}/${route_netmask_1}" > $SUBNET_FILE

LOCAL_FILE="/etc/openvpn/ovpn_server/$INSTANCE.local"
echo "${ifconfig_local}/${route_netmask_1}" > $LOCAL_FILE

# flush IPv6 address
sudo ip -6 a flush dev $dev || true

# send to firerouter redis db
redis-cli -n 1 publish "ifup" "$dev" || true

if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
  sudo iptables -w -C FW_INPUT_ACCEPT -p tcp --dport $local_port_1 -j ACCEPT &>/dev/null || sudo iptables -w -A FW_INPUT_ACCEPT -p tcp --dport $local_port_1 -j ACCEPT || true
  sudo iptables -w -C FW_INPUT_ACCEPT -p udp --dport $local_port_1 -j ACCEPT &>/dev/null || sudo iptables -w -A FW_INPUT_ACCEPT -p udp --dport $local_port_1 -j ACCEPT || true
  sudo ip6tables -w -C FW_INPUT_ACCEPT -p tcp --dport $local_port_1 -j ACCEPT &>/dev/null || sudo ip6tables -w -A FW_INPUT_ACCEPT -p tcp --dport $local_port_1 -j ACCEPT || true
  sudo ip6tables -w -C FW_INPUT_ACCEPT -p udp --dport $local_port_1 -j ACCEPT &>/dev/null || sudo ip6tables -w -A FW_INPUT_ACCEPT -p udp --dport $local_port_1 -j ACCEPT || true
  sudo iptables -w -t nat -C FW_PREROUTING_DMZ_HOST -p tcp --dport $local_port_1 -j ACCEPT &>/dev/null || sudo iptables -w -t nat -I FW_PREROUTING_DMZ_HOST -p tcp --dport $local_port_1 -j ACCEPT || true
  sudo iptables -w -t nat -C FW_PREROUTING_DMZ_HOST -p udp --dport $local_port_1 -j ACCEPT &>/dev/null || sudo iptables -w -t nat -I FW_PREROUTING_DMZ_HOST -p udp --dport $local_port_1 -j ACCEPT || true
fi

hook_server_route_up
redis-cli HINCRBY "stats:systemd:restart" openvpn 1