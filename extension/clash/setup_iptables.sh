#!/bin/bash

sudo iptables -w -t nat -F FW_CLASH_CHAIN
sudo iptables -w -t nat -X FW_CLASH_CHAIN
sudo iptables -w -t nat -N FW_CLASH_CHAIN

sudo ipset create fw_clash_whitelist hash:ip family inet hashsize 16384 maxelem 65536 &>/dev/null
sudo ipset create fw_clash_whitelist_net hash:net family inet hashsize 4096 maxelem 65536 &>/dev/null

EXCLUDED_NET="0.0.0.0/8 10.0.0.0/8 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4"
for net in $EXCLUDED_NET; do
    sudo ipset add -! fw_clash_whitelist_net $net
done

PUBLIC_IP=$(redis-cli --raw hget sys:network:info publicIp | jq -r .)
test -n "$PUBLIC_IP" && sudo iptables -w -t nat -A FW_CLASH_CHAIN -d $PUBLIC_IP -j RETURN

sudo iptables -w -t nat -A FW_CLASH_CHAIN -m set --match-set fw_clash_whitelist dst -j RETURN
sudo iptables -w -t nat -A FW_CLASH_CHAIN -m set --match-set fw_clash_whitelist_net dst -j RETURN

sudo iptables -w -t nat -A FW_CLASH_CHAIN -p tcp --match multiport --destination-port 22:1023,5228 -j REDIRECT --to-ports 9954