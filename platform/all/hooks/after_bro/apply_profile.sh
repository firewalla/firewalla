#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

# to ensure the log file is owned by pi
sudo bash -c "FW_PROFILE_KEY=taskset $FIREWALLA_HOME/scripts/apply_profile.sh" 2>&1 | sudo -u pi tee /tmp/apply_profile-bro-run.log
