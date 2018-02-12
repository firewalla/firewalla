#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_BIN:=$FIREWALLA_HOME/bin}

BINARY=bitbridge6

if [[ -e $FIREWALLA_BIN/$BINARY.rc ]]; then
  source $FIREWALLA_BIN/$BINARY.rc # taking arguments from here
fi

branch=$(cd $FIREWALLA_HOME; git rev-parse --abbrev-ref HEAD)

# both beta and prod will disable ipv6

if [[ -e $FIREWALLA_BIN/dev || (($branch == release_*) && ! -f /home/pi/.firewalla/config/enablev6) ]]; then
  cp $FIREWALLA_BIN{/mock,}/$BINARY
else
  cp $FIREWALLA_BIN{/real,}/$BINARY
fi

sudo setcap cap_net_admin,cap_net_raw=eip $FIREWALLA_BIN/$BINARY

if [[ ! -z "$BINARY_ARGUMENTS" ]]; then
  $FIREWALLA_BIN/$BINARY $BINARY_ARGUMENTS
else
  exit 1
fi

