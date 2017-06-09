#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

LOCAL_NET=$1
LOCAL_MASK=$2
VDHCP_NET=$3
VDHCP_MASK=$4

service isc-dhcp-server start

rm <$FIREWALLA_HOME/extensions/vdhcp/_dhcpd.conf.txt
sed 's/LOCAL_NET/'$LOCAL_NET'/' <$FIREWALLA_HOME/extensions/vdhcp/dhcpd.conf.txt > <$FIREWALLA_HOME/extensions/vdhcp/_dhcpd.conf.txt
sed 's/LOCAL_MASK/'$LOCAL_MASK'/' <$FIREWALLA_HOME/extensions/vdhcp/_dhcpd.conf.txt > <$FIREWALLA_HOME/extensions/vdhcp/_dhcpd.conf.txt
sed 's/VDHCP_NET/'$VDHCP_NET'/' <$FIREWALLA_HOME/extensions/vdhcp/_dhcpd.conf.txt > <$FIREWALLA_HOME/extensions/vdhcp/_dhcpd.conf.txt
sed 's/VDHCP_MASK/'$VDHCP_MASK'/' <$FIREWALLA_HOME/extensions/vdhcp/_dhcpd.conf.txt > <$FIREWALLA_HOME/extensions/vdhcp/_dhcpd.conf.txt
cp <$FIREWALLA_HOME/extensions/vdhcp/_dhcpd.conf.txt /etc/dhcp/dhcpd.conf

service isc-dhcp-server start
