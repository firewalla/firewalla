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
    sudo systemctl enable openvpn@$INSTANCE_NAME
    sudo apt-get  -y install easy-rsa
    sudo rm -r -f /etc/openvpn
    sudo mkdir /etc/openvpn
    sudo cp -r /usr/share/easy-rsa /etc/openvpn
fi

