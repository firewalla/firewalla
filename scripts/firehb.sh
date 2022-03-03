#!/bin/bash

FIREHB_PATH_NEW="/home/pi/.firewalla/run/assets/firehb"

cmd="/home/pi/firewalla/bin/node cli/heartbeat.js"
if [[ -f $FIREHB_PATH_NEW ]]; then
  cmd=$FIREHB_PATH_NEW
fi

echo "Invoking" $cmd

$cmd
