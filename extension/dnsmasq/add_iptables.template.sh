#!/usr/bin/env bash

for protocol in tcp udp; do
    for dns in $DNS_IPS; do
        RULE="-t nat -p $protocol --destination $dns --destination-port 53 -j DNAT --to-destination 127.0.0.1:8853"
        sudo iptables -C PREROUTING $RULE &>/dev/null || sudo iptables -I PREROUTING 1 $RULE
    done
done

BLACK_HOLE_IP=198.51.100.99
sudo iptables -C FORWARD --destination $BLACK_HOLE_IP -j REJECT &>/dev/null || sudo iptables -A FORWARD --destination $BLACK_HOLE_IP -j REJECT
