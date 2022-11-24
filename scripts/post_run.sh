#!/usr/bin/env bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

PLATFORM=$(uname -m)

if ! nmap -version | grep "Nmap version 7.40" &>/dev/null; then
    # need to upgrade nmap
    if [[ $PLATFORM == "armv7l" ]]; then
        sudo dpkg -i ${FIREWALLA_HOME}/vendor/libssl1.1_1.1.0f-3_armhf.deb
        sudo apt-get install -y liblua5.3-0
        sudo dpkg -i ${FIREWALLA_HOME}/vendor/nmap_7.40-1_armhf.deb
    fi
fi

if [ $(dpkg-query -W -f='${Status}' watchdog 2>/dev/null | grep -c "ok installed") -eq 0 ];
then
    if [[ $PLATFORM == "armv7l" ]]; then
        sudo dpkg -i ${FIREWALLA_HOME}/vendor/watchdog_5.14-3ubuntu0.16.04.1_armhf.deb
    fi
fi

cmp --silent ${FIREWALLA_HOME}/etc/watchdog.conf /etc/watchdog.conf || sudo cp ${FIREWALLA_HOME}/etc/watchdog.conf /etc/watchdog.conf
