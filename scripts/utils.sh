#!/bin/bash

function setup_folders() {
    mkdir -p ~/.dns
    mkdir -p ~/.firewalla/config
    mkdir -p ~/.firewalla/config/dnsmasq
    mkdir -p ~/.firewalla/config/dnsmasq_local
    mkdir -p ~/.firewalla/run
    mkdir -p ~/.forever
    mkdir -p ~/logs
    sudo chown -R pi ~/logs/
    # this is mainly for x86_64, /etc/openvpn will link to this directory
    if [[ $(uname -m) == "x86_64" ]]; then
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
