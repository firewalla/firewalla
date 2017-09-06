#!/bin/bash -
#
#    Copyright 2017 Firewalla LLC
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

#
# Ensure network is stable first then launch main-start
#
#

: ${FIREWALLA_HOME:=/home/pi/firewalla}

ntp_process_cnt=`sudo systemctl status ntp |grep 'active (running)' | wc -l`
logger "FIREWALLA.FIRETIME.ENTER "+`date`

if [[ $ntp_process_cnt == 0 ]]; then
    logger `date`
    if [[ ! -f /.dockerenv ]]; then
        logger "FIREWALLA.DATE.SYNC"
        sudo systemctl stop ntp
        sudo ntpdate -b -u -s time.nist.gov
        sudo ntpd -gq
        sudo systemctl start ntp
        logger "FIREWALLA.DATE.SYNC.DONE"
        sync
    fi
    logger `date`
else
    logger "FIREWALLA.DATE.SYNC.NTPSTARTED"
fi
