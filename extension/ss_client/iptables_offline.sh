#!/bin/bash

sudo iptables -w -t nat -C OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_LOCAL_PORT && sudo iptables -w -t nat -D OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_LOCAL_PORT

CHAIN_NAME=FW_SS${FW_NAME}

sudo iptables -w -t nat -D FW_PREROUTING -p tcp -j $CHAIN_NAME
sudo iptables -w -t nat -D OUTPUT -p tcp -j $CHAIN_NAME
