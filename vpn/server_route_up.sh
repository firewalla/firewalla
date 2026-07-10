#!/bin/bash

INSTANCE=$1

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

mkdir -p /etc/openvpn/ovpn_server

GATEWAY_FILE="/etc/openvpn/ovpn_server/$INSTANCE.gateway"
echo $route_vpn_gateway > $GATEWAY_FILE

GATEWAY6_FILE="/etc/openvpn/ovpn_server/$INSTANCE.gateway6"
echo ${ifconfig_ipv6_remote} > $GATEWAY6_FILE

SUBNET_FILE="/etc/openvpn/ovpn_server/$INSTANCE.subnet"
echo "${route_network_1}/${route_netmask_1}" > $SUBNET_FILE

SUBNET6_FILE="/etc/openvpn/ovpn_server/$INSTANCE.subnet6"
subnetwork6=$(ipcalc -nb $ifconfig_ipv6_local/$ifconfig_ipv6_netbits |awk '$1 == "Prefix:" {print $2}')
if [ -z "$subnetwork6" ]; then
  subnetwork6=$(python3 -c "import ipaddress; print(ipaddress.IPv6Network(u'${ifconfig_ipv6_local}/${ifconfig_ipv6_netbits}', strict=False).with_prefixlen)")
fi
echo "${subnetwork6}" > $SUBNET6_FILE

LOCAL_FILE="/etc/openvpn/ovpn_server/$INSTANCE.local"
echo "${ifconfig_local}/${route_netmask_1}" > $LOCAL_FILE

LOCAL6_FILE="/etc/openvpn/ovpn_server/$INSTANCE.local6"
echo "${ifconfig_ipv6_local}/${ifconfig_ipv6_netbits}" > $LOCAL6_FILE

# flush IPv6 address
# sudo ip -6 a flush dev $dev || true

# send to firerouter redis db
redis-cli -n 1 publish "ifup" "$dev" || true

if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
  _send_iptables_rule() {
    for proto in tcp udp; do
      local rule=$(cat <<-EOF
				{"family":${1},"table":"${2}","chain":"${3}","proto":["-p","${proto}"],"options":[["--dport",${local_port_1}]],"jump":"ACCEPT","operation":"${4:--A}"}
			EOF
      )
      redis-cli publish "TO.FireMain" '{"type":"Control:RuleAdded","module":"iptables","fromProcess":"server_route_up","rule":'"$rule}"
    done
  }
  _send_iptables_rule 4 filter FW_INPUT_ACCEPT
  _send_iptables_rule 6 filter FW_INPUT_ACCEPT
  _send_iptables_rule 4 nat    FW_PREROUTING_DMZ_HOST -I
fi

hook_server_route_up
redis-cli HINCRBY "stats:systemd:restart" openvpn 1