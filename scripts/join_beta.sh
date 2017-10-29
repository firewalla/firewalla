#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

function record_latest_production_branch() {
  if [[ $branch =~ release.* ]]; then
    redis-cli set prod.branch $branch
  fi
}

record_latest_production_branch

# walla repo
cd $FIREWALLA_HOME
git config remote.origin.fetch "+refs/heads/master:refs/remotes/origin/master"
git fetch origin
# master should be changed to beta branch in the future
git checkout master

# node modules repo
cd ~/.node_modules
git config remote.origin.fetch "+refs/heads/master:refs/remotes/origin/master"
git fetch origin
git checkout master

sync
logger "REBOOT: JOIN BETA"
/home/pi/firewalla/scripts/fire-reboot-normal
