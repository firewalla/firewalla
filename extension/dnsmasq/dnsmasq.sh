#!/bin/bash
/home/pi/firewalla/extension/dnsmasq/dnsmasq.x86_64 -k --clear-on-reload -u pi -C /home/pi/firewalla/extension/dnsmasq/dnsmasq.conf -r /home/pi/.firewalla/run/dnsmasq.resolv.conf --dhcp-range=tag:wlan0,10.0.218.51,10.0.218.251,255.255.255.0,24h --dhcp-option=tag:wlan0,3,10.0.218.1 --dhcp-option=tag:wlan0,6,127.0.0.53 &
trap "trap - SIGTERM && kill -- -$$" SIGINT SIGTERM EXIT
for job in `jobs -p`; do wait $job; echo "$job exited"; done
