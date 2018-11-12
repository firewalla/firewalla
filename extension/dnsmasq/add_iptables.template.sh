#!/usr/bin/env bash

for protocol in tcp udp; do
    for dns in $DNS_IPS; do
        RULE="-t nat -p $protocol --destination $dns --destination-port 53 -j DNAT --to-destination $LOCAL_IP:8853"
        sudo iptables -w -C PREROUTING $RULE &>/dev/null || sudo iptables -w -I PREROUTING 1 $RULE
    done
done

BLACK_HOLE_IP=198.51.100.99
sudo iptables -w -C FORWARD --destination $BLACK_HOLE_IP -j REJECT &>/dev/null || sudo iptables -w -A FORWARD --destination $BLACK_HOLE_IP -j REJECT
