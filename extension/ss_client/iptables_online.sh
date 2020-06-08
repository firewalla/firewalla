#!/bin/bash

if [[ -z $FW_SS_SERVER || -z $FW_SS_LOCAL_PORT ]]; then
  exit 1;
fi

CHAIN_NAME=FW_SS${FW_NAME}


sudo iptables -w -t nat -C OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_LOCAL_PORT || sudo iptables -w -t nat -A OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_LOCAL_PORT

# Apply the rules to nat client
sudo iptables -w -t nat -A FW_PREROUTING -p tcp -j $CHAIN_NAME