#!/usr/bin/env bash

for protocol in tcp udp; do
    RULE="-t nat -p $protocol --destination $GATEWAY_IP --destination-port 53 -j DNAT --to-destination $LOCAL_IP:53"
    sudo iptables -C PREROUTING $RULE &>/dev/null || sudo iptables -A PREROUTING $RULE
done

BLACK_HOLE_IP=198.51.100.99
sudo iptables -C FORWARD --destination $BLACK_HOLE_IP -j REJECT &>/dev/null || sudo iptables -A FORWARD --destination $BLACK_HOLE_IP -j REJECT