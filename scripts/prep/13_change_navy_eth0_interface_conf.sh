#!/bin/bash

if [[ $FIREWALLA_PLATFORM != "navy" ]]; then
  exit
fi

sudo sed -i "s/^auto eth0/allow-hotplug eth0/" /etc/network/interfaces.d/eth0