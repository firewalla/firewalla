#!/usr/bin/env bash

SRC=/home/pi/.docker.http-proxy.conf
DST=/etc/systemd/system/docker.service.d/http-proxy.conf

test -e $SRC || exit 0

mkdir -p $(dirname $DST)
sudo cp -f $SRC $DST
sudo systemctl daemon-reload
sudo systemctl is-active docker &>/dev/null && sudo systemctl restart docker
