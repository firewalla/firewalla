#!/usr/bin/env bash

#if [[ -z $FW_SS_SERVER || -z $FW_SS_LOCAL_PORT ]]; then
#  exit 1;
#fi

sudo iptables -t nat -D PREROUTING -p tcp -j FW_SHADOWSOCKS
sudo iptables -t nat -D OUTPUT -p tcp -j FW_SHADOWSOCKS

sudo iptables -t nat -F FW_SHADOWSOCKS
sudo iptables -t nat -X FW_SHADOWSOCKS
