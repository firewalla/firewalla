#!/bin/bash

# <local net> < local mask> <vdhcp net> <vdhcp mask>

PACKAGE_NAME=isc-dhcp-server

if ! dpkg-query -s $PACKAGE_NAME &>/dev/null; then
    sudo apt-get install -y $PACKAGE_NAME &>/dev/null
fi

