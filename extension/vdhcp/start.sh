#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

LOCAL_NET=$1
LOCAL_MASK=$2
VDHCP_NET=$3
VDHCP_MASK=$4

service isc-dhcp-server stop

rm $FIREWALLA_HOME/extension/vdhcp/_*dhcpd.conf.txt
sed 's/LOCAL_NET/'$LOCAL_NET'/' <$FIREWALLA_HOME/extension/vdhcp/dhcpd.conf.txt > $FIREWALLA_HOME/extension/vdhcp/_dhcpd.conf.txt
sed 's/LOCAL_MASK/'$LOCAL_MASK'/' <$FIREWALLA_HOME/extension/vdhcp/_dhcpd.conf.txt > $FIREWALLA_HOME/extension/vdhcp/__dhcpd.conf.txt
sed 's/VDHCP_NET/'$VDHCP_NET'/' <$FIREWALLA_HOME/extension/vdhcp/__dhcpd.conf.txt > $FIREWALLA_HOME/extension/vdhcp/___dhcpd.conf.txt
sed 's/VDHCP_NET/'$VDHCP_NET'/' <$FIREWALLA_HOME/extension/vdhcp/___dhcpd.conf.txt > $FIREWALLA_HOME/extension/vdhcp/____dhcpd.conf.txt
sed 's/VDHCP_MASK/'$VDHCP_MASK'/' <$FIREWALLA_HOME/extension/vdhcp/____dhcpd.conf.txt > $FIREWALLA_HOME/extension/vdhcp/_____dhcpd.conf.txt
cp $FIREWALLA_HOME/extension/vdhcp/_____dhcpd.conf.txt /etc/dhcp/dhcpd.conf
rm $FIREWALLA_HOME/extension/vdhcp/_*dhcpd.conf.txt

service isc-dhcp-server start
