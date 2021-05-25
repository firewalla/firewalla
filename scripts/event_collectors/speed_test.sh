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
STATE_TYPE='speed_test'
FIREWALLA_HOME='/home/pi/firewalla'
SPEEDCLI_PYTHON="$FIREWALLA_HOME/extension/speedtest/speedtest-cli"


# ----------------------------------------------------------------------------
# Functions
# ----------------------------------------------------------------------------
check_speed_python() {
    python $SPEEDCLI_PYTHON --json | jq -r '[.download,.upload,.ping,.server.host,.client.ip]|@tsv' |\
      while read download upload ping server client
      do
          labels="server=$server client=$client"
          cat <<EOS
action speed_test ${download%%.*} $labels type=download
action speed_test ${upload%%.*} $labels type=upload
action speed_test ${ping%%.*} $labels type=ping
EOS
      done
}


# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

branch=$(cd $FIREWALLA_HOME; git rev-parse --abbrev-ref HEAD)
test $branch == 'master' || exit 0

check_speed_python || exit 1

exit 0
