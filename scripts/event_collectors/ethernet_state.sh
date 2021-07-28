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
STATE_TYPE='ethernet_state'


# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------
for intf in $(ls -l /sys/class/net | awk '/^l/ && !/virtual/ && !/wlan/ {print $9}')
do
    sudo ethtool $intf | fgrep -q 'Link detected: yes'
    state_value=$?
    echo "state $STATE_TYPE $intf $state_value"
done

exit 0
