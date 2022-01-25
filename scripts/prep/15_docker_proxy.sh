#!/usr/bin/env bash

test -e /home/pi/.docker.http-proxy.conf || exit 0

sudo cp -f /home/pi/.docker.http-proxy.conf /etc/systemd/system/docker.service.d/http-proxy.conf
sudo systemctl daemon-reload
sudo systemctl is-active docker &>/dev/null && sudo systemctl restart docker
