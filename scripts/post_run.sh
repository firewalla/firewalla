#!/usr/bin/env bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

PLATFORM=$(uname -m)

if ! nmap -version | grep "Nmap version 7.40" &>/dev/null; then
    # need to upgrade nmap
    if [[ $PLATFORM == "armv7l" ]]; then
        sudo dpkg -i ${FIREWALLA_HOME}/vendor/libssl1.1_1.1.0f-3_armhf.deb
        sudo apt-get install -y liblua5.3-0
        sudo dpkg -i ${FIREWALLA_HOME}/vendor/nmap_7.40-1_armhf.deb
    elif [[ $PLATFORM == "x86_64" ]]; then
        sudo dpkg -i ${FIREWALLA_HOME}/vendor/libssl1.1_1.1.0f-3_amd64.deb
        sudo apt-get install -y liblua5.3-0
        sudo dpkg -i ${FIREWALLA_HOME}/vendor/nmap_7.40-1_amd64.deb
    fi
fi