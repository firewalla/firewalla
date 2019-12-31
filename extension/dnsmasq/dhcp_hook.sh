#!/bin/bash

ACTION=$1
MAC=$2
IP=$3
HOSTNAME=$4

redis-cli publish "dnsmasq.dhcp.lease" "{\"action\":\"$1\",\"mac\":\"$2\",\"ip\":\"$3\",\"hostname\":\"$4\"}"
exit 0