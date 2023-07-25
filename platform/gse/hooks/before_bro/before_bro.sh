#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

if [[ -e /log/blog ]]; then
  sudo ln -sfT /log/blog/current /blog/current
fi

[[ -e $CUR_DIR/broctl.cfg ]] && sudo cp $CUR_DIR/broctl.cfg /usr/local/bro/etc/zeekctl.cfg

# check conflict on bro listen port and change default port if necessary
NO_OF_INSTANCES=$(cat /usr/local/zeek/etc/node.cfg | grep "^type=" | wc -l)
for p in $(seq 4776 1 6552); do
  if ! sudo netstat -anlp | grep 127.0.0.1 | grep "ESTABLISHED\|LISTEN" | awk '{print $4" "$7}' | grep -v zeek | grep "127.0.0.1:$p[1-$NO_OF_INSTANCES]"; then
    sudo bash -c "echo 'ZeekPort = ${p}0' >> /usr/local/zeek/etc/zeekctl.cfg"
    break
  fi
done

sudo bash -c 'cat >> /usr/local/bro/share/bro/site/local.bro' <<EOS

# icmp filter
redef restrict_filters += [["not-icmp"] = "not icmp and not icmp6"];
EOS

sync
