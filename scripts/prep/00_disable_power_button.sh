#!/bin/bash

if grep -q 'HandlePowerKey=ignore' '/etc/systemd/logind.conf'; then
  exit
else
  sudo sed -i 's/#HandlePowerKey=poweroff/HandlePowerKey=ignore/' /etc/systemd/logind.conf
  sudo systemctl restart systemd-logind
fi
