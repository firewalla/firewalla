#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

if [[ ! -e /log/blog || ! -L /log/blog ]]; then
  sudo rm -rf /log/blog
  sudo ln -sfT /blog /log/blog
fi

[[ -e $CUR_DIR/broctl.cfg ]] && sudo cp $CUR_DIR/broctl.cfg /usr/local/zeek/etc/zeekctl.cfg

# check conflict on bro listen port and change default port if necessary
for p in $(seq 47760 1 65520); do
  if ! sudo netstat -anlp | grep 127.0.0.1 | grep "ESTABLISHED\|LISTEN" | awk '{print $4" "$7}' | grep -v zeek | grep "127.0.0.1:$p"; then
    sudo bash -c "echo 'ZeekPort = $p' >> /usr/local/zeek/etc/zeekctl.cfg"
    break
  fi
done

EXTERNAL_IP=$(ip addr show dev eth0 | awk '/inet /'  | grep -vw secondary | awk '$NF=="eth0" {print $2}' | cut -f1 -d/ | grep -v '^169\.254\.')
OVERLAY_IP=$(ip addr show dev eth0 | awk '/inet /'  | grep -vw secondary | awk '$NF=="eth0:0" {print $2}' | cut -f1 -d/ | grep -v '^169\.254\.')

if [[ -n "$EXTERNAL_IP" ]]; then

  sudo bash -c 'cat >> /usr/local/zeek/share/zeek/site/local.zeek' <<EOS

# local filter
redef restrict_filters += [["not-itself"] = "not (host $EXTERNAL_IP and not port 53 and not port 8853)"];
EOS
fi

if [[ -n "$OVERLAY_IP" ]]; then

  sudo bash -c 'cat >> /usr/local/zeek/share/zeek/site/local.zeek' <<EOS

# overlay filter
redef restrict_filters += [["not-itself-overlay"] = "not (host $OVERLAY_IP and tcp)"];
EOS

fi

sync
