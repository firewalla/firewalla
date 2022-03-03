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

: ${SCRIPTS_DIR:="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"}
: ${FIREWALLA_HOME:=/home/pi/firewalla}

# Cleanup if almost full(discard stdout/stderr to avoid logging failure due to disk full)
$FIREWALLA_HOME/scripts/clean_log.sh &>/dev/null

MGIT=$(PATH=$SCRIPTS_DIR:$FIREWALLA_HOME/scripts; /usr/bin/which mgit||echo git)

[ -s $FIREWALLA_HOME/scripts/firelog ] && FIRELOG=$FIREWALLA_HOME/scripts/firelog || FIRELOG=/usr/bin/logger

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

$FIRELOG -t local -m "FIREWALLA.UPGRADE($mode) Starting Check Reset"
if [ -s $SCRIPTS_DIR/check_reset.sh ]
then
    sudo $SCRIPTS_DIR/check_reset.sh
else
    sudo $FIREWALLA_HOME/scripts/check_reset.sh
fi
$FIRELOG -t local -m "FIREWALLA.UPGRADE($mode) Starting Done Check Reset"


$FIRELOG -t local -m "FIREWALLA.UPGRADE($mode) Starting FIRST"

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

LOGGER=logger
ERR=logger
[ -s $SCRIPTS_DIR/network_settings.sh ] && source $SCRIPTS_DIR/network_settings.sh || source $FIREWALLA_HOME/scripts/network_settings.sh

if [[ $FIREWALLA_PLATFORM != "gold" ]] && [[ $FIREWALLA_PLATFORM != "purple" ]]; then
  await_ip_assigned || restore_values
fi

[ -s $SCRIPTS_DIR/fire-time.sh ] && $SCRIPTS_DIR/fire-time.sh || $FIREWALLA_HOME/scripts/fire-time.sh

GITHUB_STATUS_API=https://api.github.com

$FIRELOG "$(date)"
rc=1
for i in `seq 1 5`; do
    HTTP_STATUS_CODE=`curl -m10 -s -o /dev/null -w "%{http_code}" $GITHUB_STATUS_API`
    if [[ $HTTP_STATUS_CODE == "200" ]]; then
      rc=0
      break
    fi
    $FIRELOG "ERROR: FIREWALLA.UPGRADE NO Network $i"
    sleep 1
done

if [[ $rc -ne 0 ]]
then
    $FIRELOG -t local -m "FIREWALLA.UPGRADE($mode) Starting RECOVER NETWORK"
    if [ -s $SCRIPTS_DIR/check_fix_network.sh ]
    then
        external_script='sudo  CHECK_FIX_NETWORK_REBOOT=no CHECK_FIX_NETWORK_RETRY=no $SCRIPTS_DIR/check_fix_network.sh'
    else
        external_script='sudo  CHECK_FIX_NETWORK_REBOOT=no CHECK_FIX_NETWORK_RETRY=no $FIREWALLA_HOME/scripts/check_fix_network.sh'
    fi
    $external_script &>/dev/null &
    timeout_check || $FIRELOG -t local -m "FIREWALLA.UPGRADE($mode) Starting RECOVER TIMEOUT"
    $FIRELOG -t local -m "FIREWALLA.UPGRADE($mode) Ending RECOVER NETWORK"
fi


$FIRELOG "FIREWALLA.UPGRADE.SYNCDONE"


# gold branch mapping, don't source platform.sh here as depencencies will be massive
function map_target_branch {
  case "$FIREWALLA_PLATFORM:$1" in
    "gold:release_6_0")
      echo "release_7_0"
      ;;
    "gold:beta_6_0")
      echo "beta_8_0"
      ;;
    "gold:beta_7_0")
      echo "beta_9_0"
      ;;
    "navy:release_6_0")
      echo "release_8_0"
      ;;
    "navy:beta_6_0")
      echo "beta_10_0"
      ;;
    "navy:beta_7_0")
      echo "beta_11_0"
      ;;
    "purple:release_6_0")
      echo "release_9_0"
      ;;
    "purple:beta_6_0")
      echo "beta_12_0"
      ;;
    "purple:beta_7_0")
      echo "beta_13_0"
      ;;
    "*:master")
      echo "master"
      ;;
    *)
      echo $1
      ;;
  esac
}

cd $FIREWALLA_HOME
sudo chown -R pi $FIREWALLA_HOME/.git
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
  $FIRELOG -t debug -m "FIREWALLA.UPGRADE NO UPGRADE"
  echo '======= SKIP UPGRADING BECAUSE OF FLAG /home/pi/.firewalla/config/.no_auto_upgrade ======='
  exit 0
fi

if [[ -e "/home/pi/.router/config/.no_auto_upgrade" ]]; then
  $FIRELOG -t debug -m "FIREWALLA.UPGRADE NO UPGRADE -- ON FIREROUTER"
  echo '======= SKIP UPGRADING BECAUSE OF FIREROUTER FLAG /home/pi/.router/config/.no_auto_upgrade ======='
  exit 0
fi

if $(/bin/systemctl -q is-active watchdog.service) ; then sudo /bin/systemctl stop watchdog.service ; fi
sudo rm -f $FIREWALLA_HOME/.git/*.lock
# ensure the remote fetch branch is up-to-date
git config remote.origin.fetch "+refs/heads/$remote_branch:refs/remotes/origin/$remote_branch"
git config "branch.$branch.merge" "refs/heads/$remote_branch"
GIT_COMMAND="(sudo -u pi $MGIT fetch origin $remote_branch && sudo -u pi $MGIT reset --hard FETCH_HEAD)"
eval $GIT_COMMAND ||
  (sleep 3; eval $GIT_COMMAND) ||
  (sleep 3; eval $GIT_COMMAND) ||
  (sleep 3; eval $GIT_COMMAND) || (date >> ~/.fireupgrade.failed; exit 1)

commit_after=$(git rev-parse HEAD)
current_tag=$(git describe --tags)

echo $commit_after > /tmp/REPO_HEAD
echo $current_tag > /tmp/REPO_TAG


$FIRELOG -t debug -m  "FIREWALLA.UPGRADE Done $branch"

# in case there is some upgrade change on firewalla.service
# all the rest services will be updated (in case) via firewalla.service

sudo cp $FIREWALLA_HOME/etc/firewalla.service /etc/systemd/system/.
#[ -s $FIREWALLA_HOME/etc/fireupgrade.service ]  && sudo cp $FIREWALLA_HOME/etc/fireupgrade.service /etc/systemd/system/.
sudo systemctl daemon-reload

case $mode in
    normal)
        $FIREWALLA_HOME/scripts/fireupgrade_normal.sh
        ;;
    hard)
        $FIREWALLA_HOME/scripts/fireupgrade_hard.sh
        ;;
    soft)
        $FIREWALLA_HOME/scripts/fireupgrade_soft.sh
        ;;
esac
