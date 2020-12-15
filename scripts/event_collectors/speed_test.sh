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
state speed_test download $download $labels
state speed_test upload $upload $labels
state speed_test ping $ping $labels
EOS
      done
}


# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

check_speed_python

exit 0