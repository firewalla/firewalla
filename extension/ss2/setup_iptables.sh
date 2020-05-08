#!/bin/bash

DIR="$( cd "$( dirname "$0" )" && pwd )"

# setup iptables chain
FW_SS_CHAIN="${NAME}"

sudo iptables -w -t nat -F $FW_SS_CHAIN
sudo iptables -w -t nat -X $FW_SS_CHAIN
sudo iptables -w -t nat -N $FW_SS_CHAIN

PUBLIC_IP=$(redis-cli hget sys:network:info publicIp)
test -n "$PUBLIC_IP" && sudo iptables -w -t nat -A $FW_SS_CHAIN -d $PUBLIC_IP -j RETURN

sudo iptables -w -t nat -A $FW_SS_CHAIN -d $FW_SS_SERVER -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 0.0.0.0/8 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 10.0.0.0/8 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 127.0.0.0/8 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 169.254.0.0/16 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 172.16.0.0/12 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 192.168.0.0/16 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 224.0.0.0/4 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 240.0.0.0/4 -j RETURN

#sudo iptables -w -t nat -A $FW_SS_CHAIN -p tcp -m set --match-set $FW_OVERTURE_IPSET dst -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -p tcp --destination-port 22:1023 -j REDIRECT --to-ports $FW_SS_REDIR_PORT