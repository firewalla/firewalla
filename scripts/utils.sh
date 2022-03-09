#!/bin/bash

function setup_folders() {
    mkdir -p ~/.dns
    mkdir -p ~/.firewalla/config
    mkdir -p ~/.firewalla/config/dnsmasq
    mkdir -p ~/.firewalla/config/dnsmasq_local
    mkdir -p ~/.firewalla/run/cache
    mkdir -p ~/.firewalla/run/countryData
    mkdir -p ~/.firewalla/run/docker
    mkdir -p ~/.firewalla/run/intelproxy
    mkdir -p ~/.forever
    mkdir -p ~/logs
    sudo chown -R pi ~/logs/
    mkdir -p ~/.firewalla/run/ovpn_profile
    mkdir -p ~/.firewalla/run/wg_profile
    mkdir -p ~/.firewalla/run/oc_profile
    mkdir -p ~/.firewalla/run/clash_profile
    mkdir -p ~/.firewalla/run/trojan_profile
    mkdir -p ~/.firewalla/run/ts_profile
    mkdir -p ~/.firewalla/run/zerotier_profile
    mkdir -p ~/.firewalla/run/ipsec_profile
    mkdir -p ~/.firewalla/run/zeek/scripts
    mkdir -p ~/.firewalla/run/assets
    # in case leftover docker containers are automatically started after reset, need to restore the owner/group on the runtime directory
    sudo chown -R pi:pi /home/pi/.firewalla/run
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
