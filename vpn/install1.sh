#!/bin/bash

# Update packages and install openvpn
# install1.sh <instance_name>

INSTANCE_NAME=$1
: ${INSTANCE_NAME:="server"}

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

if [ ! -f /etc/openvpn/easy-rsa/pkitool ]; then
    echo "Installing VPN server instance: $INSTANCE_NAME"
    if [[ $MANAGED_BY_FIREROUTER != "yes" ]]; then
      sudo dpkg --configure -a
      sudo apt-get update
      sudo apt-get  -y install openvpn
      sudo apt-get  -y install easy-rsa
    fi
    sudo rm -r -f /etc/openvpn
    if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
      sudo rm -rf /home/pi/openvpn/*
      sudo ln -s /home/pi/openvpn /etc/openvpn
    else
      sudo mkdir /etc/openvpn
    fi
    sudo cp -r /usr/share/easy-rsa /etc/openvpn
fi

