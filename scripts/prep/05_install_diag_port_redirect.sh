#!/bin/bash

# redirect 80 to 8835 for diag interface
for eth_ip in `ip addr show dev eth0 | awk '/inet / {print $2}'|cut -f1 -d/`; do
  sudo iptables -t nat -C PREROUTING -p tcp --destination ${eth_ip} --destination-port 80 -j REDIRECT --to-ports 8835 || sudo iptables -t nat -A PREROUTING -p tcp --destination ${eth_ip} --destination-port 80 -j REDIRECT --to-ports 8835
done