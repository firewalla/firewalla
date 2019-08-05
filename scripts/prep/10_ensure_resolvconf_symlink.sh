#!/bin/bash

if [[ -s /etc/resolv.conf && ! -L /etc/resolv.conf ]]; then
  sudo cp -f /etc/resolv.conf /run/resolvconf/resolv.conf
  sudo rm /etc/resolv.conf
  sudo ln -s /run/resolvconf/resolv.conf /etc/resolv.conf
fi