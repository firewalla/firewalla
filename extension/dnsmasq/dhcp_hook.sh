#!/bin/bash

ACTION=$1
MAC=$2
IP=$3
HOSTNAME=$4
if [[ $DNSMASQ_REQUESTED_OPTIONS != '' ]]; then
    redis-cli publish "dnsmasq.dhcp.lease" "{\"action\":\"$1\",\"mac\":\"$2\",\"ip\":\"$3\",\"hostname\":\"$4\"}"
fi

TS=$(date +%s%3N)
redis-cli zadd "dnsmasq.dhcp.event:$2" "$TS" "{\"action\":\"$1\",\"mac\":\"$2\",\"ip\":\"$3\",\"hostname\":\"$4\", \"options\":\"$DNSMASQ_REQUESTED_OPTIONS\", \"expires\":\"$DNSMASQ_LEASE_EXPIRES\", \"clientid\":\"$DNSMASQ_CLIENT_ID\", \"interface\":\"$DNSMASQ_INTERFACE\", \"ts\":\"$TS\"}"

exit 0