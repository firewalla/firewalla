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


SLEEP_INTERVAL=${SLEEP_INTERVAL:-1}
LOGGER=/usr/bin/logger
CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

err() {
    msg="$@"
    echo "ERROR: $msg" >&2
    sudo -u pi  /home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADE.ERROR $msg"
}

ERR=err

: ${FIREWALLA_HOME:=/home/pi/firewalla}
[ -s $CUR_DIR/network_settings.sh ] && source $CUR_DIR/network_settings.sh ||
    source $FIREWALLA_HOME/scripts/network_settings.sh

if [[ $FIREWALLA_PLATFORM == "gold" ]] || [[ $FIREWALLA_PLATFORM == "purple" ]]; then
    exit 0
fi

set_timeout() {
    [[ $(redis-cli get mode) == 'dhcp' ]] && echo 0 || echo $1
}

ethernet_connected() {
    [[ -e /sys/class/net/eth0/carrier ]] || return 1
    carrier=$(cat /sys/class/net/eth0/carrier)
    test $carrier -eq 1
}

ethernet_ip() {
    eth_ip=$(ip addr show dev eth0 | awk '/inet /' | awk '$NF=="eth0" {print $2}' | cut -f1 -d/ | grep -v '^169\.254\.')
    if [[ -n "$eth_ip" ]]; then
        return 0
    else
        return 1
    fi
}

gateway_pingable() {
    gw=$(ip route show dev eth0 | awk '/default/ {print $3; exit; }')
    if [[ -n "$gw" ]]; then
        # some router might not reply to ping
        ping -c1 -w3 $gw >/dev/null || sudo timeout 1200s nmap -sP -PR $gw |grep "Host is up" &> /dev/null
    else
        return 1
    fi
}

dns_resolvable() {
    nslookup -type=A -timeout=10 github.com >/dev/null
}

github_api_ok() {
    curl -L -m10 https://api.github.com/zen &> /dev/null || nc -w 5 -z 1.1.1.1 443 &> /dev/null
}

reboot_if_needed() {
    : ${CHECK_FIX_NETWORK_REBOOT:='yes'}
    if [[ $CHECK_FIX_NETWORK_REBOOT == 'no' ]]
    then
        err "CHECK_FIX_NETWORK_REBOOT is set to 'no', abort"
        exit 1
    else
        err "CHECK_FIX_NETWORK_REBOOT REBOOTING"
        reboot now
    fi
}

if [[ $(id -u) != $(id -u root) ]]; then
    err "Only root can run this script"
    exit 1
fi

NOT_RESTORED=0
RESTORED_AND_NEED_START_OVER=1
RESTORED=2

restored=$NOT_RESTORED

echo -n "checking ethernet connection ... "
$LOGGER "checking ethernet connection ... "
tmout=15
while ! ethernet_connected ; do
    if [[ $tmout -gt 0 ]]; then
        (( tmout-- ))
    else
        echo "fail - reboot"
        $LOGGER "FIREWALLA:FIX_NETWORK:REBOOT check ethernet connection"
        reboot_if_needed
    fi
    sleep 1
done
echo OK

echo -n "checking ethernet IP ... "
$LOGGER "checking ethernet IP ... "
tmout=$(set_timeout 60)
while ! ethernet_ip ; do
    if [[ $tmout -gt 0 ]]; then
        (( tmout-- ))
    else
        echo "fail - restore"
        $LOGGER "FIREWALLA:failed to get IP, restore network configurations"
        restore_values
        restored=$RESTORED
        break
    fi
    sleep 1
done
echo OK

function check_with_timeout() {
  message=$1
  action=$2
  reboot=$3

  echo -n "Trying to $message ... "
  $LOGGER "Trying to $message ... "
  tmout=15
  while ! $action; do
    if [[ $tmout -gt 0 ]]; then
      (( tmout-- ))
    else
      if [[ $restored -eq $NOT_RESTORED ]]; then
        echo "fail - restore"
        $LOGGER "failed to $message, restore network configurations"
        restore_values
        restored=$RESTORED_AND_NEED_START_OVER
        break;
      else
        # default to non-reboot, but it should always be explicitly assigned
        skip='skipped'
        [ 0 -eq $reboot ] && skip=''
        echo "fail - reboot $skip"
        $LOGGER "FIREWALLA:FIX_NETWORK:failed to $message, even after restore, reboot $skip"
        if [ 0 -eq $reboot ]; then reboot_if_needed; fi
      fi
    fi
    sleep 1
  done
  if [[ $restored -eq $RESTORED_AND_NEED_START_OVER ]]; then
    restored=$RESTORED
    return 1
  fi
  echo OK
  return 0
}

: ${CHECK_FIX_NETWORK_RETRY:='yes'}
while [[ -n $CHECK_FIX_NETWORK_RETRY ]]; do
    # only run once if requires NO retry
    test $CHECK_FIX_NETWORK_RETRY == 'no' && unset CHECK_FIX_NETWORK_RETRY

    if ! check_with_timeout "ping gateway" gateway_pingable 0; then continue; fi

    if ! check_with_timeout "resolve DNS" dns_resolvable 0; then continue; fi

    if ! check_with_timeout "test github API" github_api_ok 1; then continue; fi

    break
done

$LOGGER "FIRE_CHECK DONE"

save_values

exit $rc

