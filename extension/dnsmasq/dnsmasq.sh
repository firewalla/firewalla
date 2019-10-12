#!/bin/bash
/home/pi/firewalla/extension/dnsmasq/dnsmasq.x86_64 -k --clear-on-reload -u pi -C /home/pi/firewalla/extension/dnsmasq/dnsmasq.conf -r /home/pi/.firewalla/run/dnsmasq.resolv.conf --dhcp-range=tag:br0,10.0.0.51,10.0.0.251,255.255.255.0,24h --dhcp-option=tag:br0,3,10.0.0.1 --dhcp-option=tag:br0,6,1.1.1.1 &
trap "trap - SIGTERM && kill -- -$$" SIGINT SIGTERM EXIT
for job in `jobs -p`; do wait $job; echo "$job exited"; done
