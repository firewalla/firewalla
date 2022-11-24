#!/bin/bash

mkdir -p /home/pi/.firewalla/run/oc_profile
NETWORK_FILE="/home/pi/.firewalla/run/oc_profile/$PROFILE_ID.network"
ROUTE_FILE="/home/pi/.firewalla/run/oc_profile/$PROFILE_ID.route"
DNS_FILE="/home/pi/.firewalla/run/oc_profile/$PROFILE_ID.dns"

#env | sort

create_interface() {
	if [ -n "$INTERNAL_IP4_MTU" ]; then
		MTU=$INTERNAL_IP4_MTU
	else
		MTUDEV=`ip route get "$VPNGATEWAY" | sed -ne 's/^.*dev \([a-z0-9]*\).*$/\1/p'`
		MTU=`ip link show "$MTUDEV" | sed -ne 's/^.*mtu \([[:digit:]]\+\).*$/\1/p'`
		if [ -n "$MTU" ]; then
			MTU=`expr $MTU - 88`
		fi
	fi

	if [ -z "$MTU" ]; then
		MTU=1412
	fi
	ip link set dev $TUNDEV up mtu $MTU
	if [ -z "$INTERNAL_IP4_NETMASKLEN" ]; then
		INTERNAL_IP4_NETMASKLEN=32
	fi
	ip address add $INTERNAL_IP4_ADDRESS/$INTERNAL_IP4_NETMASKLEN peer $INTERNAL_IP4_ADDRESS dev $TUNDEV
	if [ -n "$INTERNAL_IP6_ADDRESS" ]; then
		if [ -z "$INTERNAL_IP6_NETMASK" ]; then
			INTERNAL_IP6_NETMASK="$INTERNAL_IP6_ADDRESS/128"
		fi
		ip -6 address add $INTERNAL_IP6_NETMASK dev $TUNDEV
	fi

}

destroy_interface() {
	echo "" > /dev/null
	#ip link set $TUNDEV down
	#ip link del dev $TUNDEV
}

set_endpoint_route() {
	ip route add `ip route get "$VPNGATEWAY" | sed -e 's/ /\n/g' | sed -ne '1p;/via/{N;p};/dev/{N;p};/src/{N;p};/mtu/{N;p}'`
}

unset_endpoint_route() {
	ip route del "$VPNGATEWAY"
}

save_params() {
	echo -n "" > $NETWORK_FILE
	echo -n "" > $ROUTE_FILE
	echo -n "" > $DNS_FILE
	
	echo "$INTERNAL_IP4_ADDRESS/$INTERNAL_IP4_NETMASKLEN" >> $NETWORK_FILE
	if [ -n "$INTERNAL_IP6_ADDRESS" ]; then
		if [ -z "$INTERNAL_IP6_NETMASK" ]; then
			INTERNAL_IP6_NETMASK="$INTERNAL_IP6_ADDRESS/128"
		fi
		echo "$INTERNAL_IP6_MASK" >> $NETWORK_FILE
	fi

	if [ -n "$CISCO_SPLIT_INC" ]; then
		i=0
		while [ $i -lt $CISCO_SPLIT_INC ]; do
			eval NETWORK="\${CISCO_SPLIT_INC_${i}_ADDR}"
			eval NETMASKLEN="\${CISCO_SPLIT_INC_${i}_MASKLEN}"
			if [ "$NETWORK" != "0.0.0.0" ]; then
				echo "$NETWORK/$NETMASKLEN" >> $ROUTE_FILE
			fi
			i=`expr $i + 1`
		done
	fi
	for i in $INTERNAL_IP4_DNS ; do
		echo "$i" >> $DNS_FILE
	done

	if [ -n "$CISCO_IPV6_SPLIT_INC" ]; then
		i=0
		while [ $i -lt $CISCO_IPV6_SPLIT_INC ]; do
			eval NETWORK="\${CISCO_IPV6_SPLIT_INC_${i}_ADDR}"
			eval NETMASKLEN="\${CISCO_IPV6_SPLIT_INC_${i}_MASKLEN}"
			if [ $NETWORKMASKLEN -gt 0 ]; then
				echo "$NETWORK/$NETMASKLEN" >> $ROUTE_FILE
			fi
			i=`expr $i + 1`
		done
	fi
	for i in $INTERNAL_IP6_DNS ; do
		echo $i >> $DNS_FILE
	done
}

if [[ -z "$reason" ]]; then
	echo "reason is not specified" 1>&2
	exit 1
fi

case "$reason" in
	pre-init)
		;;
	connect)
		create_interface
		set_endpoint_route
		save_params
		redis-cli publish "oc_client.connected" $PROFILE_ID
		;;
	disconnect)
		unset_endpoint_route
		destroy_interface
		;;
	reconnect)
		#destroy_interface
		#create_interface
		save_params
		redis-cli publish "oc_client.connected" $PROFILE_ID
		;;
	attempt-reconnect)
		;;
	*)
		echo "unknown reason $reason." 1>&2
		exit 1
		;;
esac

exit 0
