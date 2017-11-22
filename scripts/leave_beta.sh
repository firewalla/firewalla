#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

prod_branch=$(redis-cli get prod.branch)

if [[ -z $prod_branch ]]; then
  prod_branch="release_6_0"
fi

cur_branch=$(git rev-parse --abbrev-ref HEAD)

if [[ "$cur_branch" == "$prod_branch" ]]; then
  exit 0
fi

if [[ ! -z $prod_branch ]]; then
  cd $FIREWALLA_HOME
  git config remote.origin.fetch "+refs/heads/${prod_branch}:refs/remotes/origin/${prod_branch}"
  git fetch origin
  git checkout -f $prod_branch

  cd ~/.node_modules
  git config remote.origin.fetch "+refs/heads/${prod_branch}:refs/remotes/origin/${prod_branch}"
  git fetch origin
  git checkout -f $prod_branch
  
  sync
  logger "REBOOT: Leave Beta"
  (sleep 1; /home/pi/firewalla/scripts/fire-reboot-normal) &
fi

