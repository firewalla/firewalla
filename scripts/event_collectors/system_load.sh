#!/bin/bash

#
#    Copyright 2021 Firewalla Inc.
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
STATE_TYPE='load'
LOAD_LIMIT=6


# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

load_5min=$(awk '{print $2}' /proc/loadavg)

if [[ $(echo "$load_5min > $LOAD_LIMIT"|bc)  == '1' ]]
then
    state_value=1
else
    state_value=0
fi
echo "state $STATE_TYPE 5min $state_value"

exit 0
