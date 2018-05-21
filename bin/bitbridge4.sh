#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_BIN:=$FIREWALLA_HOME/bin}

BINARY=bitbridge7
if [[ -e $FIREWALLA_BIN/$BINARY.rc ]]; then
  source $FIREWALLA_BIN/$BINARY.rc # taking arguments from here
fi

if [[ $(uname -m) == "aarch64" ]]; then
	ln -sfT real.aarch64 real
fi

if [[ -e $FIREWALLA_BIN/dev ]]; then
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

