#!/bin/bash

function setup_folders() {
    mkdir -p ~/.dns
    mkdir -p ~/.firewalla/config
    mkdir -p ~/.firewalla/config/dnsmasq
    mkdir -p ~/.firewalla/config/dnsmasq_local
    mkdir -p ~/.firewalla/run/cache
    mkdir -p ~/.firewalla/run/countryData
    mkdir -p ~/.firewalla/run/docker
    mkdir -p ~/.forever
    mkdir -p ~/logs
    sudo chown -R pi ~/logs/
    mkdir -p ~/.firewalla/run/ovpn_profile
    test -e ~/.firewalla/.sshpasswd && sudo chown pi ~/.firewalla/.sshpasswd
    : ${FIREWALLA_HOME:=/home/pi/firewalla}

    source ${FIREWALLA_HOME}/platform/platform.sh
    # this is mainly for firerouter managed platform, /etc/openvpn will link to this directory
    if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
      mkdir -p /home/pi/openvpn
      if [[ ! -h /etc/openvpn ]]; then
        sudo rm -rf /etc/openvpn
        sudo ln -s /home/pi/openvpn /etc/openvpn
      fi
    fi
    (
        cd ~/.firewalla
        if [[ ! -e log ]]; then
            ln -s ~/.forever log;
        fi
    )
}
