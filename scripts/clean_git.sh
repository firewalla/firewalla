#!/bin/bash

CMD=${0##*/}
DATE_FORMAT='[%Y-%m-%d %H:%M:%S]'
LOG_QUIET=0
LOG_ERROR=1
LOG_WARN=2
LOG_INFO=3
LOG_DEBUG=4

: ${LOGLEVEL:=$LOG_INFO}
: ${GIT_REPACK_DEPTH:=10}
: ${GIT_REPACK_WINDOW:=10}
: ${GIT_REPACK_OPTS:='-a -d -q'}
: ${FREE_SPACE_HOME_LOW:=100000}
: ${FREE_SPACE_HOME_HIGH:=1000000}

# ----------------------------------------------------------------------------
# Functions
# ----------------------------------------------------------------------------

mylog() {
    echo "$(date +"$DATE_FORMAT")$@"
}
mylogn() {
    echo -n "$(date +"$DATE_FORMAT")$@"
}

logdebug() {
    test $LOGLEVEL -ge $LOG_DEBUG || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[DEBUG] $@" >&2
    else
        mylog "[DEBUG] $@" >&2
    fi
}

loginfo() {
    test $LOGLEVEL -ge $LOG_INFO || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[INFO] $@"
    else
        mylog "[INFO] $@"
    fi
}

logwarn() {
    test $LOGLEVEL -ge $LOG_WARN || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[WARN] $@" >&2
    else
        mylog "[WARN] $@" >&2
    fi
}

logerror() {
    test $LOGLEVEL -ge $LOG_ERROR || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[ERROR] $@" >&2
    else
        mylog "[ERROR] $@" >&2
    fi
}

usage() {
  cat <<EOU
usage: $CMD <path_to_git_workspace>

env:

  LOGLEVEL: $LOGLEVEL
  GIT_REPACK_DEPTH: $GIT_REPACK_DEPTH
  GIT_REPACK_WINDOW: $GIT_REPACK_WINDOW
  GIT_REPACK_OPTS: $GIT_REPACK_OPTS
  FREE_SPACE_HOME_LOW: $FREE_SPACE_HOME_LOW
  FREE_SPACE_HOME_HIGH: $FREE_SPACE_HOME_HIGH

examples:

  # Do a manual run with default limits
  $0 /home/pi/firewalla

  # Force(by tweaking limits) a run
  FREE_SPACE_HOME_LOW=0 FREE_SPACE_HOME_HIGH=9999999 $0 /home/pi/firewalla

  # Do a complete run
  GIT_REPACK_OPTS='-a -d -f' $0 /home/pi/firewalla
EOU
}

clean_git() {
  ( cd $1
    branch_current=$(git rev-parse --abbrev-ref HEAD)
    ${MASTER_ONLY:-true} && {
      test $branch_current == 'master' || {
        logerror "Cannot clean git for non-master branch($branch_current)"
        exit 1
      }
    }
    loginfo "Cleaning .git in $1 ..."
    du -sh $1/.git
    rm -f .git/objects/*/tmp_* && rm -f .git/objects/*/.tmp-*
    loginfo "git repack $GIT_REPACK_OPTS --depth=$GIT_REPACK_DEPTH --window=$GIT_REPACK_WINDOW"
    if git repack $GIT_REPACK_OPTS --depth=$GIT_REPACK_DEPTH --window=$GIT_REPACK_WINDOW
    then
      du -sh $1/.git
      loginfo "Complete"
      exit 0
    else
      logerror "git repack failed"
      exit 1
    fi
  )
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

test $# -gt 0 || {
  usage
  exit 0
}

free_space_home=$(df  --output=avail --sync /home | sed -n 2p)

if (( free_space_home < FREE_SPACE_HOME_LOW ))
then
    logerror "Free space in /home($free_space_home) is too low(<$FREE_SPACE_HOME_LOW) to clean .git safely."
    exit 1
fi

if (( free_space_home > FREE_SPACE_HOME_HIGH ))
then
    loginfo "Free space in /home($free_space_home) is high(>$FREE_SPACE_HOME_HIGH). No need to clean .git ."
    exit 0
fi

clean_git $1