#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

sudo bash -c "FW_PROFILE_KEY=taskset $FIREWALLA_HOME/scripts/apply_profile.sh &> /tmp/apply_profile-bro-run.log"
