#!/bin/bash

set -e

: ${FIREWALLA_HOME:=/home/pi/firewalla}
MGIT=$(PATH=/home/pi/scripts:$FIREWALLA_HOME/scripts; /usr/bin/which mgit||echo git)
CMD=$(basename $0)
source ${FIREWALLA_HOME}/platform/platform.sh

usage() {
    cat <<EOU
usage: $CMD <branch>
example:

    # switch to master
    $CMD master

    # switch to pre_release
    $CMD beta_6_0

EOU
}

err() {
    msg="$@"
    echo "ERROR: $msg" >&2
}

switch_branch() {
    cur_branch=$1
    tgt_branch=$2
    if [[ "$cur_branch" == "$tgt_branch" ]]; then
      exit 0
    fi
    remote_branch=$(map_target_branch $branch)
    # walla repo
    ( cd $FIREWALLA_HOME
    git config remote.origin.fetch "+refs/heads/$remote_branch:refs/remotes/origin/$remote_branch"
    $MGIT fetch origin $remote_branch
    git checkout -f -B $tgt_branch origin/$remote_branch
    )

    # node modules repo
    ( cd ~/.node_modules
    git config remote.origin.fetch "+refs/heads/$tgt_branch:refs/remotes/origin/$tgt_branch"
    $MGIT fetch origin $tgt_branch
    git checkout -f -B $tgt_branch origin/$tgt_branch
    )
}

set_redis_flag() {
    redis_flag=
    case $1 in
        release_*)
            redis_flag=1
            ;;
        beta_7_*)
            redis_flag=4
            ;;
        beta_6_*)
            redis_flag=2
            ;;            
        master)
            redis_flag=3
            ;;
    esac
    test -n "$redis_flag" || return 1
    redis-cli hset sys:config branch.changed $redis_flag &>/dev/null
}

# --------------
# MAIN goes here
# --------------

test $# -gt 0 || {
    usage
    err "branch is required"
    exit 1
}

branch=$1
cur_branch=$(git rev-parse --abbrev-ref HEAD)
switch_branch $cur_branch $branch || exit 1
set_redis_flag $branch || exit 2

sync
logger "REBOOT: SWITCH branch from $cur_branch to $branch"
