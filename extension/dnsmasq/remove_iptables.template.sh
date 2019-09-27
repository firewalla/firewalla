#!/usr/bin/env bash

for protocol in tcp udp; do
    for dns in $DNS_IPS; do
        RULE="-t nat -p $protocol --destination $dns -m set ! --match-set no_dns_caching_mac_set src --destination-port 53 -j DNAT --to-destination $LOCAL_IP:8853"
        sudo iptables -w -C PREROUTING $RULE &>/dev/null && sudo iptables -w -D PREROUTING $RULE
    done
done

