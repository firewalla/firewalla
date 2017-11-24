#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
CMD=$(basename $0)

usage() {
    cat <<EOU
usage: $CMD <branch>
example:

    # switch to master
    $CMD master

    # switch to pre_release
    $CMD beta_*_0

EOU
}

err() {
    msg="$@"
    echo "ERROR: $msg" >&2
}

function record_latest_production_branch() {
  if [[ ${branch:0:8} == 'release.' ]]; then
    redis-cli set prod.branch $branch
  fi
}

fetch_and_checkout_branch() {
    cur_branch=$(git rev-parse --abbrev-ref HEAD)
    if [[ "$cur_branch" == "$1" ]]; then
      exit 0
    fi
    # walla repo
    cd $FIREWALLA_HOME
    git config remote.origin.fetch "+refs/heads/$target_branch:refs/remotes/origin/$target_branch"
    git fetch origin
    git checkout -f $target_branch

    # node modules repo
    cd ~/.node_modules
    git config remote.origin.fetch "+refs/heads/$target_branch:refs/remotes/origin/$target_branch"
    git fetch origin
    git checkout -f $target_branch
}

test $# -gt 0 || {
    usage
    err "branch is required"
    exit 1
}

target_branch=$1
record_latest_production_branch
fetch_and_checkout_branch $target_branch

sync
logger "REBOOT: JOIN BETA"
(sleep 1; /home/pi/firewalla/scripts/fire-reboot-normal) &
