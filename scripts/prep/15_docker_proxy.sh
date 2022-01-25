#!/usr/bin/env bash

# run as root/sudo

SRC=/home/pi/.docker.http-proxy.conf
DST=/etc/systemd/system/docker.service.d/http-proxy.conf

test -e $SRC || exit 0

cmp $SRC $DST && exit 0

mkdir -p $(dirname $DST)
cp -f $SRC $DST
systemctl daemon-reload
systemctl is-active docker &>/dev/null && sudo systemctl restart docker
