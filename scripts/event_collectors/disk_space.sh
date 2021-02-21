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
STATE_TYPE='diskspace'
: ${PATHS:='/ /home /data /log'}
: ${LIMIT_PCENT:=90}
: ${LIMIT_AVAIL:=50000}


# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------
for path in $PATHS
do
    used_pcent=$(df --output=pcent $path | tail -1 | tr -d ' %')
    avail=$(df -k --output=avail $path | tail -1| tr -d ' ')
    size=$(df -k --output=size $path | tail -1 | tr -d ' ')
    labels="percent_used=$used_pcent percent_limit=$LIMIT_PCENT kbytes_size=$size kbytes_available=$avail kbytes_limit=$LIMIT_AVAIL"
    state_value=0
    if [[ $used_pcent -gt $LIMIT_PCENT || $avail -lt $LIMIT_AVAIL ]]
    then
        state_value=1
    fi
    echo "state $STATE_TYPE $path $state_value $labels"
done

exit 0
