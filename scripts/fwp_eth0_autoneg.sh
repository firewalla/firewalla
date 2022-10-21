#!/bin/bash

if [[ -n $1 ]]; then
  sudo ethtool -s eth0 autoneg on speed $1 duplex full
else
  sudo ethtool -s eth0 autoneg on
fi
