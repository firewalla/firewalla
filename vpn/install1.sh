#!/bin/bash

# Update packages and install openvpn

if [ ! -f /etc/openvpn/easy-rsa/pkitool ]; then
    echo "Installing"
    sudo dpkg --configure -a
    sudo apt-get update
    sudo apt-get  -y install openvpn
    sudo systemctl enable openvpn@server
    sudo apt-get  -y install easy-rsa
    sudo rm -r -f /etc/openvpn
    sudo mkdir /etc/openvpn
    sudo cp -r /usr/share/easy-rsa /etc/openvpn
fi

