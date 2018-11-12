#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

cd $FIREWALLA_HOME

$FIREWALLA_HOME/bin/node scripts/diag_hello.js