#!/bin/bash

PROFILE_ID=$1
PUSH_OPTIONS_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.push_options"
rm -f $PUSH_OPTIONS_FILE
for optionname in ${!foreign_option_*} ; do
  option="${!optionname}"
  echo $option >> $PUSH_OPTIONS_FILE
done

# loosen reverse path filter
sudo sysctl -w net.ipv4.conf.${dev}.rp_filter=2 || true

chown pi $PUSH_OPTIONS_FILE
# remove file with gateway IP, which will be created by route-up scripts afterward
GATEWAY_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.gateway"
rm -f $GATEWAY_FILE
# remove file with subnet mask, which will be created by route-up scripts afterward
SUBNET_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.subnet"
rm -f $SUBNET_FILE
