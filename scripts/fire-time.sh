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

function sync_time() {
    time_website=$1
    time=$(curl -D - ${time_website} -o /dev/null --silent | egrep "^Date:" | awk -F ": " '{print $2}')
    if [[ "x$time" == "x" ]]; then
        return 1
    else
        sudo date -s "$time"
    fi    
}

if [[ $ntp_process_cnt == 0 ]]; then
    logger `date`
    if [[ ! -f /.dockerenv ]]; then
        logger "FIREWALLA.DATE.SYNC"
        sync_time status.github.com || sync_time google.com || sync_time live.com || sync_time facebook.com
        sudo systemctl stop ntp
        sudo ntpdate -b -u -s time.nist.gov
        sudo timeout 30 ntpd -gq
        sudo systemctl start ntp
        logger "FIREWALLA.DATE.SYNC.DONE"
        sync
    fi
    logger `date`
else
    logger "FIREWALLA.DATE.SYNC.NTPSTARTED"
fi
