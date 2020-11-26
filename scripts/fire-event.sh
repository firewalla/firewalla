#!/bin/bash

# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------

CMD=$(basename $0)
CMDDIR=$(dirname $0)
FIREWALLA_HOME=$(cd $CMDDIR; git rev-parse --show-toplevel)
: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

# ----------------------------------------------------------------------------
# Function
# ----------------------------------------------------------------------------

usage() {
    cat <<EOU
usage: $CMD {list|state|action|clean} [<options>]

  # list events from <begin> till <end>
  $CMD list <begin> <end>

  # clean events from <begin> till <end>
  $CMD clean <begin> <end>

  # add state event with state_type/state_key/state_value
  $CMD state <state_type> <state_key> <state_value>

  # add action event with action_type/action_value
  $CMD action <action_type> <action_value>

EOU
}

mylog() {
    echo "$(date):$@"
}

loginfo() {
    mylog "INFO: $@"
}

logerror() {
    mylog "ERROR:$@" >&2
}

add_state_event() {
    test $# -ge 3 || { logerror need state_type/state_key/state_value; return 1; }
    redis-cli publish 'event:request:state' "{\"state_type\":\"$1\",\"state_key\":\"$2\",\"state_value\":$3}"
}

add_action_event() {
    test $# -ge 2 || { logerror need action_type/action_value; return 1; }
    redis-cli publish 'event:request:action' "{\"action_type\":\"$1\",\"action_value\":$2}"
}

clean_event() {
    begin=${1:-0}
    end=${2:-0}
    redis-cli publish 'event:request:clean' "{\"begin\":\"$begin\",\"end\":"$end"}"
}

list_event() {
    redis-cli zrangebyscore 'event:log' ${1:-'0'} ${2:-'inf'} withscores
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

rc=0

test $# -gt 0 || { usage; exit 0; }

cmd=$1; shift

case $cmd in 
    list) list_event "$@" || rc=1
        ;;
    state) add_state_event "$@" || rc=1
        ;;
    action) add_action_event "$@" || rc=1
        ;;
    clean) clean_event "$@" || rc=1
        ;;
    *) usage
       logerror "un-supported command - $cmd"
       rc=1
        ;;
esac

exit $rc
