#!/bin/bash

if [[ ! -e /log/blog || ! -L /log/blog ]]; then
  sudo rm -rf /log/blog
  sudo ln -sfT /blog /log/blog
fi

# check conflict on bro listen port and change default port if necessary
for p in $(seq 47760 1 65520); do
  if ! sudo netstat -anlp | grep 127.0.0.1 | grep "ESTABLISHED\|LISTEN" | awk '{print $4" "$7}' | grep -v bro | grep "127.0.0.1:$p"; then
    sudo bash -c "echo 'BroPort = $p' >> /usr/local/bro/etc/broctl.cfg"
    break
  fi
done

sync
