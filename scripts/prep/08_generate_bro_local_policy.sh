#!/bin/bash

if [[ -f /usr/local/bro/share/bro/policy/protocols/conn/mac-logging.bro ]]; then
    sed -i 's=#@load policy/protocols/conn/mac-logging=@load policy/protocols/conn/mac-logging=' /home/pi/firewalla/etc/local.bro # uncomment mac-logging if file exists
fi