#!/usr/bin/env bash

if [[ -z $FW_SS_SERVER || -z $FW_SS_LOCAL_PORT ]]; then
  exit 1;
fi

CHAIN_NAME=FW_SS${FW_NAME}

sudo iptables -w -t nat -N $CHAIN_NAME
sudo iptables -w -t nat -A $CHAIN_NAME -d $FW_SS_SERVER -j RETURN
sudo iptables -w -t nat -A $CHAIN_NAME -d 0.0.0.0/8 -j RETURN
sudo iptables -w -t nat -A $CHAIN_NAME -d 10.0.0.0/8 -j RETURN
sudo iptables -w -t nat -A $CHAIN_NAME -d 127.0.0.0/8 -j RETURN
sudo iptables -w -t nat -A $CHAIN_NAME -d 169.254.0.0/16 -j RETURN
sudo iptables -w -t nat -A $CHAIN_NAME -d 172.16.0.0/12 -j RETURN
sudo iptables -w -t nat -A $CHAIN_NAME -d 192.168.0.0/16 -j RETURN
sudo iptables -w -t nat -A $CHAIN_NAME -d 224.0.0.0/4 -j RETURN
sudo iptables -w -t nat -A $CHAIN_NAME -d 240.0.0.0/4 -j RETURN


sudo iptables -w -t nat -A $CHAIN_NAME -p tcp -m set --match-set chnroute dst -j RETURN

sudo iptables -w -t nat -A $CHAIN_NAME -p tcp --destination-port 22:1023 -j REDIRECT --to-ports $FW_SS_LOCAL_PORT


