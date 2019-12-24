#!/bin/bash

for f in /usr/local/bro/share/bro/policy/protocols/conn/mac-logging.*; do
  [ -f "$f" ] && sed -i 's=#@load policy/protocols/conn/mac-logging=@load policy/protocols/conn/mac-logging=' /home/pi/firewalla/etc/local.bro # uncomment mac-logging if file exists
done
