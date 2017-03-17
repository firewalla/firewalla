#!/bin/bash

PACKAGE_NAME=dhcpdump

if ! dpkg-query -s $PACKAGE_NAME &>/dev/null; then
    sudo apt-get install -y dhcpdump &>/dev/null
fi

