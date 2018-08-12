#!/bin/bash

sudo iptables -t nat -C OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_LOCAL_PORT && sudo iptables -t nat -D OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_LOCAL_PORT

sudo iptables -t nat -D PREROUTING -p tcp -j FW_SHADOWSOCKS${FW_NAME}
sudo iptables -t nat -D OUTPUT -p tcp -j FW_SHADOWSOCKS${FW_NAME}