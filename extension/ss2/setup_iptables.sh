#!/bin/bash

DIR="$( cd "$( dirname "$0" )" && pwd )"

# setup iptables chain
FW_SS_CHAIN="${NAME}"

sudo iptables -w -t nat -F $FW_SS_CHAIN
sudo iptables -w -t nat -X $FW_SS_CHAIN
sudo iptables -w -t nat -N $FW_SS_CHAIN

FW_SS2_WHITE_LIST=fw_ss2_whitelist
FW_SS2_WHITE_LIST_NET=fw_ss2_whitelist_net

sudo ipset create $FW_SS2_WHITE_LIST hash:ip family inet hashsize 16384 maxelem 65536 &>/dev/null
sudo ipset add $FW_SS2_WHITE_LIST $FW_SS_SERVER
sudo ipset create $FW_SS2_WHITE_LIST_NET hash:net family inet hashsize 4096 maxelem 65536 &>/dev/null

EXCLUDED_NET="0.0.0.0/8 10.0.0.0/8 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4"
for net in $EXCLUDED_NET; do
    sudo ipset add $FW_SS2_WHITE_LIST_NET $net
done

PUBLIC_IP=$(redis-cli hget sys:network:info publicIp)
test -n "$PUBLIC_IP" && sudo iptables -w -t nat -A $FW_SS_CHAIN -d $PUBLIC_IP -j RETURN

sudo iptables -w -t nat -A $FW_SS_CHAIN -m set --match-set $FW_SS2_WHITE_LIST dst -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -m set --match-set $FW_SS2_WHITE_LIST_NET dst -j RETURN

# overture use DoH directly
#sudo iptables -w -t nat -A $FW_SS_CHAIN -p tcp -m set --match-set $FW_OVERTURE_IPSET dst -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -p tcp --destination-port 22:1023 -j REDIRECT --to-ports $FW_SS_REDIR_PORT