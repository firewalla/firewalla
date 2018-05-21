#!/usr/bin/env bash

if [[ -z $FW_SS_SERVER || -z $FW_SS_LOCAL_PORT ]]; then
  exit 1;
fi

sudo iptables -t nat -N FW_SHADOWSOCKS
sudo iptables -t nat -A FW_SHADOWSOCKS -d $FW_SS_SERVER -j RETURN
sudo iptables -t nat -A FW_SHADOWSOCKS -d 0.0.0.0/8 -j RETURN
sudo iptables -t nat -A FW_SHADOWSOCKS -d 10.0.0.0/8 -j RETURN
sudo iptables -t nat -A FW_SHADOWSOCKS -d 127.0.0.0/8 -j RETURN
sudo iptables -t nat -A FW_SHADOWSOCKS -d 169.254.0.0/16 -j RETURN
sudo iptables -t nat -A FW_SHADOWSOCKS -d 172.16.0.0/12 -j RETURN
sudo iptables -t nat -A FW_SHADOWSOCKS -d 192.168.0.0/16 -j RETURN
sudo iptables -t nat -A FW_SHADOWSOCKS -d 224.0.0.0/4 -j RETURN
sudo iptables -t nat -A FW_SHADOWSOCKS -d 240.0.0.0/4 -j RETURN

# for black hole ip, return it, no ss routing
sudo iptables -t nat -A FW_SHADOWSOCKS -d 198.51.100.99 -j RETURN

sudo iptables -t nat -A FW_SHADOWSOCKS -p tcp -m set --match-set chnroute dst -j RETURN

sudo iptables -t nat -A FW_SHADOWSOCKS -p tcp --destination-port 22:1023 -j REDIRECT --to-ports $FW_SS_LOCAL_PORT
sudo iptables -t nat -C OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_LOCAL_PORT || sudo iptables -t nat -A OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_LOCAL_PORT

# Apply the rules to nat client
sudo iptables -t nat -A PREROUTING -p tcp -j FW_SHADOWSOCKS

