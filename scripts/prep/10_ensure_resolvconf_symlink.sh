#!/bin/bash

if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
  exit
fi

if [[ -s /etc/resolv.conf && -d /run/resolvconf && ! -L /etc/resolv.conf ]]; then
  sudo cp -f /etc/resolv.conf /run/resolvconf/resolv.conf
  sudo rm /etc/resolv.conf
  sudo ln -s /run/resolvconf/resolv.conf /etc/resolv.conf
fi