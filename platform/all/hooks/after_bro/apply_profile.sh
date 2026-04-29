#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

# to ensure the log file is owned by pi
sudo bash -c "FW_PROFILE_KEYS=\"taskset nic_feature rps_cpus\" $FIREWALLA_HOME/scripts/apply_profile.sh -f" 2>&1 | sudo -u pi tee /tmp/apply_profile-bro-run.log