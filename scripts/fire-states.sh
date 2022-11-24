#!/bin/bash

#
#    Copyright 2020 Firewalla Inc.
#
#    This program is free software: you can redistribute it and/or  modify
#    it under the terms of the GNU Affero General Public License, version 3,
#    as published by the Free Software Foundation.
#
#    This program is distributed in the hope that it will be useful,
#    but WITHOUT ANY WARRANTY; without even the implied warranty of
#    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#    GNU Affero General Public License for more details.
#
#    You should have received a copy of the GNU Affero General Public License
#    along with this program.  If not, see <http://www.gnu.org/licenses/>.
#


# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------

CMD=$(basename $0)
CMDDIR=$(dirname $0)
FIREWALLA_HOME=$(cd $CMDDIR; git rev-parse --show-toplevel)
SYS_STATES='sys:states'
SYS_STATES_CHANNEL='sys:states:channel'
: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

# ----------------------------------------------------------------------------
# Function
# ----------------------------------------------------------------------------

usage() {
    cat <<EOU
usage: $CMD { get [<key>] | set <key> {ok|fail} }

examples:

  # get system state for LED
  $CMD get boot_state

  # set system state for LED
  $CMD set firereset fail

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

get_state() {
    if [[ -n "$1" ]]; then
        redis-cli hget $SYS_STATES $1
    else
        redis-cli hgetall $SYS_STATES
    fi
}

set_state() {
    redis-cli publish $SYS_STATES_CHANNEL "$1"
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

rc=0

test $# -gt 0 || { usage; exit 0; }

cmd=$1; shift

case $cmd in 
    get)
        get_state "$@" || rc=1
        ;;
    set)
        set_state "{\"$1\": \"$2\" }" || rc=1
        ;;
    *) usage
       logerror "un-supported command - $cmd"
       rc=1
        ;;
esac

exit $rc
