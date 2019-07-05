#!/bin/bash

PROFILE_ID=$1
PUSH_OPTIONS_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.push_options"
rm -f $PUSH_OPTIONS_FILE
for optionname in ${!foreign_option_*} ; do
  option="${!optionname}"
  echo $option >> $PUSH_OPTIONS_FILE
done

chown pi $PUSH_OPTIONS_FILE