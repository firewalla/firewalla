#!/bin/bash

set -e

# setup a wg test environment with a given wireguard public key from wg0
# you can select by `frcc .interface.wireguard.wg0.peers`

PUBLIC_KEY="$1"

if [[ "x$PUBLIC_KEY" == "x" ]]; then
        echo "Argument public key is required
        usage: ./setup_wg_test.sh <wg_pub_key>"
        exit 0
fi

WAN_IP=$(redis-cli hget sys:network:info $(ip r show default | awk '{print $5}') | jq .ip_address -r)
FRCC="curl -s http://localhost:8837/v1/config/active 2>/dev/null"
PORT=$($FRCC | jq .interface.wireguard.wg0.listenPort)
BOX_PUBLIC_KEY=$($FRCC | jq -r .interface.wireguard.wg0.privateKey | wg pubkey)
BOX_IP=$($FRCC | jq .interface.wireguard.wg0.ipv4 -r | sed 's=/24==g')
PRIVATE_KEY=$($FRCC | jq ".interface.wireguard.wg0.extra.peers[] | select(.publicKey==\"$PUBLIC_KEY\") | .privateKey" -r)
IP=$($FRCC | jq ".interface.wireguard.wg0.peers[] | select(.publicKey==\"$PUBLIC_KEY\") | .allowedIPs[]" -r | sed 's=/32==')

FOLDER=~/.firewalla/run/docker/wg_test

mkdir -p $FOLDER/wireguard/

cat > $FOLDER/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey=$PRIVATE_KEY
Address=$IP/32
DNS=$BOX_IP
MTU=1412
[Peer]
PublicKey=$BOX_PUBLIC_KEY
Endpoint=$WAN_IP:$PORT
AllowedIPs=0.0.0.0/0
EOF

cat > $FOLDER/docker-compose.yml <<EOF
version: '3.7'

services:
  wireguard:
    image: linuxserver/wireguard
    container_name: wg_test
    volumes:
      - './wireguard:/config'
      - '/lib/modules:/lib/modules:ro'
    environment:
      - PUID=1000
      - PGID=1000
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    sysctls:
      - net.ipv4.conf.all.src_valid_mark=1
EOF

cd $FOLDER
sudo docker-compose up -d

NETWORK_ID=$(sudo docker inspect wg_test -f "{{json .NetworkSettings.Networks.wg_test_default.NetworkID }}" | jq . -r)
NETWORK_PREFIX=${NETWORK_ID:0:12}
INTF_NAME=br-$NETWORK_PREFIX
echo $INTF_NAME

INTF_IP=$(ip addr show dev $INTF_NAME | awk '/inet / {print $2}')
NETWORK_ADDR=$(ipcalc -nb $INTF_IP | awk '$1 == "Network:" {print $2}')

sudo ip r add $NETWORK_ADDR dev $INTF_NAME table static &>/dev/null || true
sudo docker exec -it wg_test /bin/bash
