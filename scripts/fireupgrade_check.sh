#!/bin/bash

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

# This script should only handle upgrade, nothing else
#
# WARNING:  EXTRA CARE NEEDED FOR THIS SCRIPT!  ANYTHING BROKEN HERE
# WILL PREVENT UPGRADES!

: ${FIREWALLA_HOME:=/home/pi/firewalla}
MGIT=$(PATH=/home/pi/scripts:$FIREWALLA_HOME/scripts; /usr/bin/which mgit||echo git)
source ${FIREWALLA_HOME}/platform/platform.sh

cd /home/pi/firewalla
branch=$(git rev-parse --abbrev-ref HEAD)
remote_branch=$(map_target_branch $branch)
$MGIT fetch --tags

current_hash=$(git rev-parse HEAD)
latest_hash=$(git rev-parse origin/$remote_branch)

/home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADECHECK.CHECK Starting, local hash: $current_hash, remote hash $latest_hash"

if [ "$current_hash" == "$latest_hash" ]; then
  /home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADECHECK.DONE.NOTHING"
   exit 0
fi

/home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADECHECK.SOFT Starting $current_hash to $latest_hash"
/home/pi/firewalla/scripts/fireupgrade.sh soft