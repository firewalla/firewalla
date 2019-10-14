#!/bin/bash

DIR="$( cd "$( dirname "$0" )" && pwd )"

NAME=$1
if [[ -e $DIR/ss_client.${NAME}.rc ]]; then
  source $DIR/ss_client.${NAME}.rc
fi

: ${FW_SS_CONFIG_PATH:="${HOME}/.firewalla/run/ss_client.${NAME}.config.json"}

: ${FW_SS_REDIR_BINARY:="${DIR}/bin.$(uname -m)/fw_ss_redir"}
: ${FW_SS_REDIR_PID_FILE:="${HOME}/.firewalla/run/ss_client.redir.pid"}
: ${FW_SS_REDIR_PORT:=8820}
: ${FW_SS_REDIR_ADDRESS:="0.0.0.0"}

: ${FW_SS_CLIENT_BINARY:="${DIR}/bin.$(uname -m)/fw_ss_client"}
: ${FW_SS_CLIENT_PORT:=8822}
: ${FW_SS_CLIENT_PID_FILE:="${HOME}/.firewalla/run/ss_client.client.pid"}
: ${FW_SS_CLIENT_ADDRESS:="0.0.0.0"}

: ${FW_OVERTURE_BINARY:="${DIR}/bin.$(uname -m)/overture"}
: ${FW_OVERTURE_CONFIG:="${HOME}/.firewalla/run/overture.${NAME}.config.json"}
: ${FW_OVERTURE_IPSET:="c_bd_country:CN_set"}

: ${FW_REMOTE_DNS:="8.8.8.8"}
: ${FW_REMOTE_DNS_PORT:=53}

# redirection
# /home/pi/firewalla/extension/ss_client/fw_ss_redir
#  -c /home/pi/.firewalla/config/ss_client.config.json
#  -l 8820
#  -f /home/pi/.firewalla/run/ss_client.redir.pid
#  -b 0.0.0.0
$FW_SS_REDIR_BINARY -c $FW_SS_CONFIG_PATH -l $FW_SS_REDIR_PORT -f $FW_SS_REDIR_PID_FILE -b $FW_SS_REDIR_ADDRESS

# ss_client
# /home/pi/firewalla/extension/ss_client/fw_ss_client
#  -c /home/pi/.firewalla/config/ss_client.config.json
#  -l 8822
#  -f /home/pi/.firewalla/run/ss_client.pid
#  -b 0.0.0.0
$FW_SS_CLIENT_BINARY -c $FW_SS_CONFIG_PATH -l $FW_SS_CLIENT_PORT -f $FW_SS_CLIENT_PID_FILE -b $FW_SS_CLIENT_ADDRESS

# overture
$FW_OVERTURE_BINARY -c $FW_OVERTURE_CONFIG &

# setup iptables chain
FW_SS_CHAIN="FW_SHADOWSOCKS_${NAME}"

sudo iptables -w -t nat -F $FW_SS_CHAIN
sudo iptables -w -t nat -X $FW_SS_CHAIN
sudo iptables -w -t nat -N $FW_SS_CHAIN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d $FW_SS_SERVER -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 0.0.0.0/8 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 10.0.0.0/8 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 127.0.0.0/8 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 169.254.0.0/16 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 172.16.0.0/12 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 192.168.0.0/16 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 224.0.0.0/4 -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 240.0.0.0/4 -j RETURN

# for black hole ip, return it, no ss routing
sudo iptables -w -t nat -A $FW_SS_CHAIN -d 198.51.100.99 -j RETURN
#sudo iptables -w -t nat -A $FW_SS_CHAIN -p tcp -m set --match-set $FW_OVERTURE_IPSET dst -j RETURN
sudo iptables -w -t nat -A $FW_SS_CHAIN -p tcp --destination-port 22:1023 -j REDIRECT --to-ports $FW_SS_REDIR_PORT

# make sure tcp 53 traffic goes to ss tunnel
sudo iptables -w -t nat -C OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_REDIR_PORT || \
sudo iptables -w -t nat -A OUTPUT -p tcp --destination $FW_REMOTE_DNS --destination-port $FW_REMOTE_DNS_PORT -j REDIRECT --to-ports $FW_SS_REDIR_PORT

if [[ ! -z $FW_SS_SERVER ]]; then
  sudo iptables -w -t nat -I ${FW_SS_CHAIN} -d ${FW_SS_SERVER} -j RETURN
fi

for job in `jobs -p`; do
    wait $job
done