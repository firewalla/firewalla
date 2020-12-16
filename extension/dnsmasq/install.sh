#!/bin/bash

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# check if dnsmasq package is already installed, go install if not yet

#if ! dpkg -s dnsmasq &>/dev/null; then
#    sudo apt-get install dnsmasq -y
#fi

: ${FIREWALLA_HOME:=/home/pi/firewalla}

# Directory for firewalla dns configuration file
mkdir -p /home/pi/.firewalla/config/dns

# sudo cp $SCRIPT_DIR/dnsmasq.template.conf /etc/dnsmasq.conf

