#!/bin/bash

sudo sed -i 's/#HandlePowerKey=poweroff/HandlePowerKey=ignore/' /etc/systemd/logind.conf

sudo systemctl restart systemd-logind
