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

# This script should only handle upgrade, nothing else
#
# WARNING:  EXTRA CARE NEEDED FOR THIS SCRIPT!  ANYTHING BROKEN HERE
# WILL PREVENT UPGRADES!

# timeout_check - timeout control given process or last background process
# returns:
#   0 - process exits before timeout
#   1 - process killed due to timeout

: ${FIREWALLA_HOME:=/home/pi/firewalla}
MGIT=$(PATH=/home/pi/scripts:$FIREWALLA_HOME/scripts; /usr/bin/which mgit||echo git)
source ${FIREWALLA_HOME}/platform/platform.sh

# ensure that run directory already exists
mkdir -p /home/pi/.firewalla/run

mode=${1:-'normal'}

timeout_check() {
    pid=${1:-$!}
    timeout=${2:-120}
    interval=${3:-1}
    delay=${4:-3}
    while (( timeout>0 ))
    do
        sleep $interval
        (( timeout-=$interval ))
        sudo kill -0 $pid || return 0
    done

    sudo kill -s TERM $pid
    sleep $delay
    sudo kill -0 $pid || return 1
    if sudo kill -0 $pid
    then
        sudo kill -s SIGKILL $pid
    fi
    return 1
}

/home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADE($mode) Starting Check Reset"+`date`
if [ -s /home/pi/scripts/check_reset.sh ]
then
    sudo /home/pi/scripts/check_reset.sh
else
    sudo /home/pi/firewalla/scripts/check_reset.sh
fi
/home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADE($mode) Starting Done Check Reset"+`date`


/home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADE($mode) Starting FIRST "+`date`

function await_ip_assigned() {
    for i in `seq 1 70`; do
        gw=$(ip route show | awk '/default/ {print $3; exit; }' | head -n 1)
        if [[ ! -n $gw ]]; then
            sleep 1
        else
            logger "IP address is assigned"
            return 0
        fi
    done
    logger "IP address is not assigned yet."
    return 1
}

set_value() {
    kind=$1
    saved_value=$2
    case ${kind} in
        ip)
            sudo /sbin/ip addr replace ${saved_value} dev eth0
            ;;
        gw)
            sudo /sbin/route add default gw ${saved_value} eth0
            ;;
    esac
}

restore_values() {
    r=0
    logger "Restore saved values of ip/gw/dns"
    for kind in ip gw
    do
        file=/home/pi/.firewalla/run/saved_${kind}
        [[ -e "$file" ]] || continue
        saved_value=$(cat $file)
        [[ -n "$saved_value" ]] || continue
        set_value $kind $saved_value || r=1
    done
    if [[ -e /home/pi/.firewalla/run/saved_resolv.conf ]]; then
        sudo /bin/cp -f /home/pi/.firewalla/run/saved_resolv.conf /etc/resolv.conf
    else
        r=1
    fi
    sleep 3
    return $r
}

await_ip_assigned || restore_values

$FIREWALLA_HOME/scripts/fire-time.sh

GITHUB_STATUS_API=https://api.github.com

logger `date`
rc=1
for i in `seq 1 5`; do
    HTTP_STATUS_CODE=`curl -m10 -s -o /dev/null -w "%{http_code}" $GITHUB_STATUS_API`
    if [[ $HTTP_STATUS_CODE == "200" ]]; then
      rc=0
      break
    fi
    /usr/bin/logger "ERROR: FIREWALLA.UPGRADE NO Network $i"
    sleep 1
done

if [[ $rc -ne 0 ]]
then
    /home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADE($mode) Starting RECOVER NETWORK "+`date`
    external_script='sudo  CHECK_FIX_NETWORK_REBOOT=no CHECK_FIX_NETWORK_RETRY=no /home/pi/firewalla/scripts/check_fix_network.sh'
    if [ -s /home/pi/scripts/check_fix_network.sh ]
    then
        external_script='sudo  CHECK_FIX_NETWORK_REBOOT=no CHECK_FIX_NETWORK_RETRY=no /home/pi/scripts/check_fix_network.sh'
    else
        external_script='sudo  CHECK_FIX_NETWORK_REBOOT=no CHECK_FIX_NETWORK_RETRY=no /home/pi/firewalla/scripts/check_fix_network.sh'
    fi
    $external_script &>/dev/null &
    timeout_check || /home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADE($mode) Starting RECOVER TIMEOUT"+`date`
    /home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADE($mode) Ending RECOVER NETWORK "+`date`
fi


/usr/bin/logger "FIREWALLA.UPGRADE.SYNCDONE  "+`date`


cd /home/pi/firewalla
sudo chown -R pi /home/pi/firewalla/.git
branch=$(git rev-parse --abbrev-ref HEAD)
remote_branch=$(map_target_branch $branch)

# continue to try upgrade even github api is not successfully.
# very likely to fail

echo "upgrade on branch $branch"

commit_before=$(git rev-parse HEAD)
current_tag=$(git describe --tags)

echo $commit_before > /tmp/REPO_HEAD
echo $current_tag > /tmp/REPO_TAG
echo $branch > /tmp/REPO_BRANCH

if [[ -e "/home/pi/.firewalla/config/.no_auto_upgrade" ]]; then
  /home/pi/firewalla/scripts/firelog -t debug -m "FIREWALLA.UPGRADE NO UPGRADE"
  echo '======= SKIP UPGRADING BECAUSE OF FLAG /home/pi/.firewalla/config/.no_auto_upgrade ======='
  exit 0
fi

if $(/bin/systemctl -q is-active watchdog.service) ; then sudo /bin/systemctl stop watchdog.service ; fi
sudo rm -f /home/pi/firewalla/.git/*.lock
GIT_COMMAND="(sudo -u pi $MGIT fetch origin $remote_branch && sudo -u pi $MGIT reset --hard FETCH_HEAD)"
eval $GIT_COMMAND ||
  (sleep 3; eval $GIT_COMMAND) ||
  (sleep 3; eval $GIT_COMMAND) ||
  (sleep 3; eval $GIT_COMMAND) || (date >> ~/.fireupgrade.failed; exit 1)

commit_after=$(git rev-parse HEAD)
current_tag=$(git describe --tags)

echo $commit_after > /tmp/REPO_HEAD
echo $current_tag > /tmp/REPO_TAG


/home/pi/firewalla/scripts/firelog -t debug -m  "FIREWALLA.UPGRADE Done $branch"

# in case there is some upgrade change on firewalla.service
# all the rest services will be updated (in case) via firewalla.service

sudo cp /home/pi/firewalla/etc/firewalla.service /etc/systemd/system/.
#[ -s /home/pi/firewalla/etc/fireupgrade.service ]  && sudo cp /home/pi/firewalla/etc/fireupgrade.service /etc/systemd/system/.
sudo cp /home/pi/firewalla/etc/brofish.service /etc/systemd/system/.
sudo systemctl daemon-reload

if [[ $(uname -m) == "x86_64" ]]; then
    sudo systemctl disable firewalla
    sudo systemctl disable fireupgrade
    sudo systemctl disable brofish
else
    sudo systemctl reenable firewalla
    sudo systemctl reenable fireupgrade
    sudo systemctl reenable brofish
fi


case $mode in
    normal)
        /home/pi/firewalla/scripts/fireupgrade_normal.sh
        ;;
    hard)
        /home/pi/firewalla/scripts/fireupgrade_hard.sh
        ;;
    soft)
        /home/pi/firewalla/scripts/fireupgrade_soft.sh
        ;;
esac
