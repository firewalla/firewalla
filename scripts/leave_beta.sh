#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

prod_branch=$(redis-cli get prod.branch)

if [[ ! -z $prod_branch ]]; then
  cd $FIREWALLA_HOME
  git config remote.origin.fetch "+refs/heads/${prod_branch}:refs/remotes/origin/${prod_branch}"
  git fetch origin
  git checkout $prod_branch

  cd ~/.node_modules
  git config remote.origin.fetch "+refs/heads/${prod_branch}:refs/remotes/origin/${prod_branch}"
  git fetch origin
  git checkout $prod_branch
  
  sync
  logger "REBOOT: Leave Beta"
  /home/pi/firewalla/scripts/fire-reboot-normal  
fi

