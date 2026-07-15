#!/bin/bash

set -e

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}
MGIT=$(PATH=/home/pi/scripts:$FIREWALLA_HOME/scripts; /usr/bin/which mgit||echo git)
CMD=$(basename $0)
source ${FIREWALLA_HOME}/platform/platform.sh
source ${FIREWALLA_HOME}/scripts/upgrade_verify.sh

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
    if [[ -e /etc/firewalla-release ]]; then
      BOARD=$( . /etc/firewalla-release 2>/dev/null && echo $BOARD || cat /etc/firewalla-release )
    else
      BOARD='unknown'
    fi
    arch=$(uname -m)
    if [[ $BOARD == "orange" ]]; then
      # restore the libxt_tls.so and libxt_udp_tls.so
      for module_name in "xt_tls" "xt_udp_tls"; do
        so_path_alt="/media/root-ro/usr/lib/${arch}-linux-gnu/xtables/lib${module_name}.so"
        if [[ -f $so_path_alt ]]; then
          sudo install -D -v -m 644 ${so_path_alt} /usr/lib/${arch}-linux-gnu/xtables
        fi
      done
    fi

    remote_branch=$(map_target_branch $branch)
    # walla repo
    ( cd $FIREWALLA_HOME
    uv_ensure_release_key
    uv_update_version_floor
    git config remote.origin.fetch "+refs/heads/$remote_branch:refs/remotes/origin/$remote_branch"
    $MGIT fetch origin $remote_branch
    if ! uv_verify_release_commit "origin/$remote_branch"; then
        err "target branch $remote_branch failed release verification, abort"
        exit 1
    fi
    git checkout -f -B $tgt_branch origin/$remote_branch
    )

    # node modules repo; the pin file comes from the target branch tree
    # checked out (and verified) above
    NM_PIN_FILE=$(uv_node_modules_pin_file 2>/dev/null)
    if type -t uv_sync_node_modules &>/dev/null && [[ -s $NM_PIN_FILE ]]; then
      if ! UV_GIT=$MGIT uv_sync_node_modules ~/.node_modules "$(get_node_modules_url)" $tgt_branch $NM_PIN_FILE; then
        err "node modules pin sync failed, node modules unchanged"
      fi
    else
      err "no node modules pin for platform $FIREWALLA_PLATFORM, legacy update"
      ( cd ~/.node_modules
      git config remote.origin.fetch "+refs/heads/$tgt_branch:refs/remotes/origin/$tgt_branch"
      $MGIT fetch origin $tgt_branch
      git checkout -f -B $tgt_branch origin/$tgt_branch
      )
    fi
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
    redis-cli del sys:bone:url &>/dev/null
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
rm -f "$FIREWALLA_HIDDEN/config/.no_auto_upgrade"
set_redis_flag $branch || exit 2

# although main_start includes following code, it may not be executed if current branch and target branch have the same latest hash
if [ ! -f $FIREWALLA_HOME/bin/dev ]; then
  if [[ $branch =~ release.* ]]; then
    echo $branch > /tmp/FWPRODUCTION
  else
    [[ -e /tmp/FWPRODUCTION ]] && rm /tmp/FWPRODUCTION
  fi
else
  rm /tmp/FWPRODUCTION
fi

sync
logger "REBOOT: SWITCH branch from $cur_branch to $branch"
