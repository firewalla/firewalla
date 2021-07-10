#!/bin/bash

sudo ipset create fw_clash_blacklist hash:ip family inet hashsize 16384 maxelem 65536 &>/dev/null
sudo ipset create fw_clash_whitelist hash:ip family inet hashsize 16384 maxelem 65536 &>/dev/null
sudo ipset create fw_clash_whitelist_net hash:net family inet hashsize 4096 maxelem 65536 &>/dev/null
sudo ipset create fw_clash_whitelist_mac hash:mac &>/dev/null

EXCLUDED_NET="0.0.0.0/8 10.0.0.0/8 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4"
for net in $EXCLUDED_NET; do
    sudo ipset add -! fw_clash_whitelist_net $net
done

sudo iptables -w -t mangle -F FW_CLASH_CHAIN &>/dev/null
sudo iptables -w -t mangle -X FW_CLASH_CHAIN &>/dev/null
sudo iptables -w -t mangle -N FW_CLASH_CHAIN &>/dev/null

# only support TCP yet
sudo iptables -w -t mangle -A FW_CLASH_CHAIN ! -p tcp -j RETURN

# add blacklist first
sudo iptables -w -t mangle -A FW_CLASH_CHAIN -m set --match-set fw_clash_blacklist dst -j MARK --set-mark $MARK

# skip high port range for p2p or other traffic
sudo iptables -w -t mangle -A FW_CLASH_CHAIN -p tcp -m tcp --dport 1024:65535 -j RETURN

sudo iptables -w -t mangle -A FW_CLASH_CHAIN -m set --match-set fw_clash_whitelist dst -j RETURN
sudo iptables -w -t mangle -A FW_CLASH_CHAIN -m set --match-set fw_clash_whitelist_net dst -j RETURN
sudo iptables -w -t mangle -A FW_CLASH_CHAIN -m set --match-set fw_clash_whitelist_mac src -j RETURN

sudo iptables -w -t mangle -A FW_CLASH_CHAIN -m set --match-set monitored_net_set src,src -j MARK --set-mark $MARK

#sudo iptables -w -t mangle -A FW_CLASH_CHAIN -j SET --map-set $IPSET dst --map-mark
