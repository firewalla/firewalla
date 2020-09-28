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

EXTERNAL_IP=$(ip addr show dev eth0 | awk '/inet /' | awk '$NF=="eth0" {print $2}' | cut -f1 -d/ | grep -v '^169\.254\.')
OVERLAY_IP=$(ip addr show dev eth0 | awk '/inet /' | awk '$NF=="eth0:0" {print $2}' | cut -f1 -d/ | grep -v '^169\.254\.')

if [[ -n "$EXTERNAL_IP" ]]; then

  sudo bash -c 'cat >> /usr/local/bro/share/bro/site/local.bro' <<EOS

# local filter
redef restrict_filters += [["not-itself"] = "not (host $EXTERNAL_IP and not port 53 and not port 8853)"];
EOS

if [[ -n "$OVERLAY_IP" ]]; then

  sudo bash -c 'cat >> /usr/local/bro/share/bro/site/local.bro' <<EOS

# overlay filter
redef restrict_filters += [["not-itself-overlay"] = "not (host $OVERLAY_IP and tcp)"];
EOS

fi

sync
