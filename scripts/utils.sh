#!/bin/bash

function setup_folders() {
    mkdir -p ~/.dns
    mkdir -p ~/.firewalla/config
    mkdir -p ~/.firewalla/config/dnsmasq
    mkdir -p ~/.firewalla/config/dnsmasq_local
    mkdir -p ~/.firewalla/run
    mkdir -p ~/.forever
    mkdir -p ~/logs
    # this is mainly for x86_64, /etc/openvpn will link to this directory
    mkdir -p /home/pi/openvpn
    (
        cd ~/.firewalla
        if [[ ! -e log ]]; then
            ln -s ~/.forever log;
        fi
    )
}
