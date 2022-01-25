#!/usr/bin/env bash

test -e /home/pi/.docker.http-proxy.conf || exit 0

sudo cp -f /home/pi/.docker.http-proxy.conf /etc/sysetmd/system/docker.service.d/http-proxy.conf
sudo systemctl is-active docker &>/dev/null && sudo systemctl restart docker
