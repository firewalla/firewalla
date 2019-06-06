#!/bin/bash

DIR="$( cd "$( dirname "$0" )" && pwd )"

NAME=$1
if [[ -e $DIR/ss_client.${NAME}.rc ]]; then
  source $DIR/ss_client.${NAME}.rc
fi

: ${FW_SS_REDIR_PORT:=8820}

: ${FW_REMOTE_DNS:="8.8.8.8"}
: ${FW_REMOTE_DNS_PORT:=53}

# setup iptables chain
FW_SS_CHAIN="FW_SHADOWSOCKS_${NAME}"

# make sure tcp 53 traffic goes to ss tunnel
sudo iptables -w -t nat -C OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_REDIR_PORT && \
sudo iptables -w -t nat -D OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_REDIR_PORT

sudo iptables -w -t nat -X $FW_SS_CHAIN &>/dev/null
