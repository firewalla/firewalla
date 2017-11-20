#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

function record_latest_production_branch() {
  if [[ $branch =~ release.* ]]; then
    redis-cli set prod.branch $branch
  fi
}

record_latest_production_branch

cur_branch=$(git rev-parse --abbrev-ref HEAD)

if [[ "$cur_branch" == "master" ]]; then
  exit 0
fi


# walla repo
cd $FIREWALLA_HOME
git config remote.origin.fetch "+refs/heads/master:refs/remotes/origin/master"
git fetch origin
# master should be changed to beta branch in the future
git checkout -f master

# node modules repo
cd ~/.node_modules
git config remote.origin.fetch "+refs/heads/master:refs/remotes/origin/master"
git fetch origin
git checkout -f master

sync
logger "REBOOT: JOIN BETA"
(sleep 1; /home/pi/firewalla/scripts/fire-reboot-normal) &
