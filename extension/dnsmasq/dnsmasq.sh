#!/bin/bash
sudo /home/pi/firewalla/extension/dnsmasq/dnsmasq.armv7l -k -x /home/pi/.firewalla/run/dnsmasq.pid -u pi -C /home/pi/firewalla/extension/dnsmasq/dnsmasq.conf -r /home/pi/.firewalla/run/dnsmasq.resolv.conf --local-service 
