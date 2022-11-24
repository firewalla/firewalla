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
: ${LOAD_LIMIT_LOW:=10}
: ${LOAD_LIMIT_HIGH:=15}


# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

read load_1min load_5min load_15min rest < /proc/loadavg

if [[ $(echo "$load_5min<$LOAD_LIMIT_LOW"|bc)  == '1' ]]
then
    echo "state $STATE_TYPE 5min 0 load_1min=$load_1min load_5min=$load_5min load_15min=$load_15min"
fi

if [[ $(echo "$load_5min>$LOAD_LIMIT_HIGH"|bc)  == '1' ]]
then
    echo "state $STATE_TYPE 5min 1 load_1min=$load_1min load_5min=$load_5min load_15min=$load_15min"
fi

exit 0
