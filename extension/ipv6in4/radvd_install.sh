#!/bin/bash

if ! dpkg -l radvd &>/dev/null; then
  sudo apt-get install radvd -y
fi

