#!/bin/bash

#
#    Copyright 2017-2020 Firewalla Inc.
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
# Try keep system time in sync
#

: ${FIREWALLA_HOME:=/home/pi/firewalla}

logger "FIREWALLA.DATE.SYNC"

TIME_THRESHOLD="2020-03-27"

tsThreshold=$(date -d "$TIME_THRESHOLD" +%s)
tsFakeHwclock=$(date -u -d "$(cat /etc/fake-hwclock.data)" +%s)
if [ $tsFakeHwclock -ge $tsThreshold ]; then tsThreshold=$tsFakeHwclock; fi

function sync_time() {
    time_website=$1
    logger "syncing time from ${time_website}..."
    time=$(curl -ILsm5 ${time_website} | awk -F ": " '/^[Dd]ate: / {print $2}'|tail -1)
    if [[ "x$time" == "x" ]]; then
        logger "ERROR: Failed to load date info from website: $time_website"
        return 1
    else
        # compare website time against threshold to prevent it goes bad in some rare cases
        tsWebsite=$(date -d "$time" +%s)
        if [ $tsWebsite -ge $tsThreshold ];
        then
          echo "$tsWebsite";
          return 0
        else
          return 1
        fi
    fi
}

ntp_process_cnt=`sudo systemctl status ntp |grep 'active (running)' | wc -l`
if [[ $ntp_process_cnt == 0 ]]; then
    logger "ntp not running, restart"
    sudo systemctl stop ntp
    sudo timeout 30 ntpd -gq || sudo ntpdate -b -u -s time.nist.gov
    sudo systemctl start ntp
fi

if [[ ! -f /.dockerenv ]]; then
    tsWebsite=$(sync_time status.github.com || sync_time google.com || sync_time live.com || sync_time facebook.com)
    tsSystem=$(date +%s)
    if [ "0$tsWebsite" -ge "0$tsSystem" ]; # prefix 0 as tsWebsite could be empty
    then
      sudo date +%s -s "@$tsWebsite";
    fi
    logger "FIREWALLA.DATE.SYNC.DONE $([ ! -z "$tsWebsite" ] && date -d @$tsWebsite)"
    sync
fi
