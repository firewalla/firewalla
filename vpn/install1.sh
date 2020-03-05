#!/bin/bash

# Update packages and install openvpn
# install1.sh <instance_name>

INSTANCE_NAME=$1
: ${INSTANCE_NAME:="server"}
if [ ! -f /etc/openvpn/easy-rsa/pkitool ]; then
    echo "Installing VPN server instance: $INSTANCE_NAME"
    sudo dpkg --configure -a
    sudo apt-get update
    sudo apt-get  -y install openvpn
    sudo apt-get  -y install easy-rsa
    sudo rm -r -f /etc/openvpn
    if [[ $(uname -m) == "x86_64" ]]; then
      sudo rm -rf /home/pi/openvpn/*
      sudo ln -s /home/pi/openvpn /etc/openvpn
    else
      sudo mkdir /etc/openvpn
    fi
    sudo cp -r /usr/share/easy-rsa /etc/openvpn
fi

