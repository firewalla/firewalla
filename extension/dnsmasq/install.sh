#!/bin/bash

// check if dnsmasq package is already installed, go install if not yet

if ! dpkg -s dnsmasq &>/dev/null; then
    sudo apt-get install dnsmasq -y
fi

