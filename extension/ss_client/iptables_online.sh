#!/bin/bash

if [[ -z $FW_SS_SERVER || -z $FW_SS_LOCAL_PORT ]]; then
  exit 1;
fi

CHAIN_NAME=FW_SHADOWSOCKS${FW_NAME}


sudo iptables -t nat -C OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_LOCAL_PORT || sudo iptables -t nat -A OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_LOCAL_PORT

# Apply the rules to nat client
sudo iptables -t nat -A PREROUTING -p tcp -j $CHAIN_NAME