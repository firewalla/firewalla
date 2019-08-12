#!/bin/bash

PROFILE_ID=$1
PUBLIC_IP_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.public_ip"
rm -f $PUBLIC_IP_FILE
# trying to get the public IP as soon as routes are created
curl https://api.ipify.org > $PUBLIC_IP_FILE || true

# remove routes pushed from OpenVPN server due to redirect-gateway options
sudo ip route del 0.0.0.0/1 || true
sudo ip route del 128.0.0.0/1 || true