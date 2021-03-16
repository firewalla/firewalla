#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

# check conflict on bro listen port and change default port if necessary
for p in $(seq 47760 1 65520); do
  if ! sudo netstat -anlp | grep 127.0.0.1 | grep "ESTABLISHED\|LISTEN" | awk '{print $4" "$7}' | grep -v bro | grep "127.0.0.1:$p"; then
    sudo bash -c "echo 'BroPort = $p' >> /usr/local/bro/etc/zeekctl.cfg"
    break
  fi
done

sync
