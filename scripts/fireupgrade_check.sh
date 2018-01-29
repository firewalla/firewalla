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

cd /home/pi/firewalla
branch=$(git rev-parse --abbrev-ref HEAD)
$MGIT fetch --tags

current_tag=$(git describe --tags)
latest_tag=$(git describe --tags `git rev-parse origin/$branch`)

current_version=$(git describe --abbrev=0 --tags)
latest_version=$(git describe --abbrev=0 --tags `git rev-parse origin/$branch`)

IFS=. read -a splited_current_version <<< "$current_version"
IFS=. read -a splited_latest_version <<< "$latest_version"

current_major_version=${splited_current_version[0]}
latest_major_version=${splited_latest_version[0]}

/home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADECHECK.CHECK Starting $current_tag,$latest_tag,$current_version,$latest_version,$current_major_version,$latest_major_version"

if [ "$current_tag" == "$latest_tag" ]; then  
   /home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADECHECK.DONE.NOTHING"
   exit 0
fi 

if [ "$current_major_version" == "$latest_major_version" ]; then
   /home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADECHECK.SOFT Starting $current_tag to $latest_tag"
   redis-cli publish System:Upgrade:Soft $latest_tag
   /home/pi/firewalla/scripts/fireupgrade.sh soft
else
   /home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADECHECK.HARD Starting $current_tag to $latest_tag"
   redis-cli publish System:Upgrade:Hard $latest_version
   redis-cli set sys:upgrade $latest_version
fi
