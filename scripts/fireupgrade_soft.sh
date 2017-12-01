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
# This script must be called from fireupgrade.sh

: ${FIREWALLA_HOME:=/home/pi/firewalla}

# call post upgrade
${FIREWALLA_HOME}/scripts/fireupgrade_post.sh 

# call upgrade
${FIREWALLA_HOME}/scripts/firelog -t cloud -m  "INFO: Upgrade completed with services restart in soft mode $commit_before $commit_after"
touch /tmp/FWUPGRADING
touch /home/pi/.firewalla/managed_reboot

# call main-run without restarting firekick
export NO_FIREKICK_RESTART=1
${FIREWALLA_HOME}/scripts/main-run
