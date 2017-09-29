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

mode=${1:-'normal'}

/usr/bin/logger "FIREWALLA.UPGRADE($mode) Starting FIRST "+`date`

GITHUB_STATUS_API=https://status.github.com/api.json

logger `date`
for i in `seq 1 10`; do
    HTTP_STATUS_CODE=`curl -s -o /dev/null -w "%{http_code}" $GITHUB_STATUS_API`
    if [[ $HTTP_STATUS_CODE == "200" ]]; then
      break
    fi
    /usr/bin/logger "FIREWALLA.UPGRADE NO Network"
    sleep 1
done


if [[ ! -f /.dockerenv ]]; then
    logger "FIREWALLA.UPGRADE.DATE.SYNC"
    sudo systemctl stop ntp
    sudo ntpdate -b -u -s time.nist.gov
    sudo timeout 30 ntpd -gq
    sudo systemctl start ntp
    logger "FIREWALLA.UPGRADE.DATE.SYNC.DONE"
    sync
fi

/usr/bin/logger "FIREWALLA.UPGRADE.SYNCDONE  "+`date`

if [[ -e "/home/pi/.firewalla/config/.no_auto_upgrade" ]]; then
  /usr/bin/logger "FIREWALLA.UPGRADE NO UPGRADE"
  exit 0
fi

cd /home/pi/firewalla
cd .git
sudo chown -R pi *
cd ..
branch=$(git rev-parse --abbrev-ref HEAD)

# continue to try upgrade even github api is not successfully.
# very likely to fail

echo "upgrade on branch $branch"

commit_before=$(git rev-parse HEAD)

GIT_COMMAND="(sudo -u pi git fetch origin $branch && sudo -u pi git reset --hard FETCH_HEAD)"
eval $GIT_COMMAND ||
(sleep 3; eval $GIT_COMMAND) ||
(sleep 3; eval $GIT_COMMAND) || exit 1

commit_after=$(git rev-parse HEAD)

#(sudo -u pi git fetch origin $branch && sudo -u pi git reset --hard FETCH_HEAD) || exit 1
/usr/bin/logger "FIREWALLA.UPGRADE Done $branch"

# in case there is some upgrade change on firewalla.service
# all the rest services will be updated (in case) via firewalla.service
sudo cp /home/pi/firewalla/etc/firewalla.service /etc/systemd/system/.
sudo cp /home/pi/firewalla/etc/fireupgrade.service /etc/systemd/system/.
sudo cp /home/pi/firewalla/etc/brofish.service /etc/systemd/system/.
sudo systemctl daemon-reload
sudo systemctl reenable firewalla
sudo systemctl reenable fireupgrade
sudo systemctl reenable brofish

case $mode in
    normal)
        logger "INFO: Upgrade completed in normal mode"
        ;;
    hard)
        logger "INFO: Upgrade completed with reboot in hard mode"
        sudo reboot now
        ;;
    soft)
        logger "INFO: Upgrade completed with services restart in soft mode"
        if [[ "$commit_before" != "$commit_after" ]];  then
            for svc in api main mon
            do
                sudo systemctl restart fire${svc}
            done
        fi
        ;;
esac
