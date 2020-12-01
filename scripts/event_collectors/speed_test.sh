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
    python $SPEEDCLI_PYTHON | while read line; do
        speed_download=$(echo "$line"| awk '/Download: / {print $2}')
        unit_download=$(echo "$line" | awk '/Download: / {print $3}')
        speed_upload=$(echo "$line" | awk '/Upload: / {print $2}')
        unit_upload=$(echo "$line" | awk '/Upload: / {print $3}')
        if [[ -n "$speed_download" && -n "$unit_download" ]]; then
            echo "state $STATE_TYPE download $speed_download unit=$unit_download"
        elif [[ -n "$speed_upload" && -n "$unit_upload" ]]; then
            echo "state $STATE_TYPE upload $speed_upload unit=$unit_upload"
        fi
    done
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

check_speed_python

exit 0
