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

INTFS=$(cat /usr/local/zeek/etc/node.cfg | grep "^interface=" | awk -F= '{print $2}')

for INTF in $INTFS; do
  IPS=$(ip --br a show dev $INTF | awk '{for(i=3;i<=NF;++i)print $i}'  | grep -v ":" | awk -F/ '{print $1}')
  for IP in $IPS; do
    sudo bash -c 'cat >> /usr/local/bro/share/bro/site/local.bro' <<EOS

# local filter
redef restrict_filters += [["not-$IP"] = "not (host $IP and not port 53 and not port 8853)"];
EOS
  done
done;

sudo bash -c 'cat >> /usr/local/bro/share/bro/site/local.bro' <<EOS

# icmp filter
redef restrict_filters += [["not-icmp"] = "not icmp and not icmp6"];
EOS

sync
