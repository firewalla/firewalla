#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

[[ -e $CUR_DIR/broctl.cfg ]] && sudo cp $CUR_DIR/broctl.cfg /usr/local/bro/etc/broctl.cfg
[[ -e $CUR_DIR/broctl.cfg ]] && sudo cp $CUR_DIR/broctl.cfg /usr/local/bro/etc/zeekctl.cfg

TMP_FILE="/home/pi/.firewalla/config/local.bro"
if [ -f "${TMP_FILE}" ]; then
  [[ -e $CUR_DIR/local.bro ]] && sudo bash -c "cat $CUR_DIR/local.bro ${TMP_FILE} > /usr/local/bro/share/bro/site/local.bro"
else
  [[ -e $CUR_DIR/local.bro ]] && sudo cp $CUR_DIR/local.bro /usr/local/bro/share/bro/site/local.bro
fi

: ${VPN_PORT:=1194}
: ${VPN_PROTOCOL:=udp}

EXTERNAL_IP=$(ip addr show dev eth0 | awk '/inet /' | awk '$NF=="eth0" {print $2}' | cut -f1 -d/ | grep -v '^169\.254\.')

VPN_CONFIG=$(redis-cli hget policy:system vpn)

if [[ -n "$VPN_CONFIG" ]]; then
  PROTOCOL=$(echo $VPN_CONFIG | jq -r '.protocol')
  PORT=$(echo $VPN_CONFIG | jq -r '.localPort')

  if [[ $PROTOCOL != "null" && "x$PROTOCOL" != "x" ]]; then
    VPN_PROTOCOL=$PROTOCOL
  fi

  if [[ $PORT != "null" && "x$PORT" != "x" ]]; then
    VPN_PORT=$PORT
  fi
fi

if [[ -n "$EXTERNAL_IP" ]]; then

  sudo bash -c 'cat >> /usr/local/bro/share/bro/site/local.bro' <<EOS

# local filter
redef restrict_filters += [["not-itself"] = "not (host $EXTERNAL_IP and not port 53 and not port 8853)"];
EOS

fi

sync
