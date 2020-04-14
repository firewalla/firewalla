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

if [[ $(uname -m) == "x86_64" ]]; then
    exit 0
fi

SLEEP_INTERVAL=${SLEEP_INTERVAL:-1}
LOGGER=/usr/bin/logger

err() {
    msg="$@"
    echo "ERROR: $msg" >&2
    sudo -u pi  /home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADE.ERROR $msg"
}

get_value() {
    kind=$1
    case $kind in
        ip)
            /sbin/ip addr show dev eth0 | awk '/inet /' | awk '$NF=="eth0" {print $2}' | fgrep -v 169.254. | fgrep -v -w 0.0.0.0 | fgrep -v -w 255.255.255.255 | head -n 1
            ;;
        gw)
            /sbin/ip route show dev eth0 | awk '/default via/ {print $3}' | grep -oE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b"  | fgrep -v -w 0.0.0.0 | fgrep -v -w 255.255.255.255
            ;;
    esac
}

set_timeout() {
    [[ $(redis-cli get mode) == 'dhcp' ]] && echo 0 || echo $1
}

save_values() {
    r=0
    $LOGGER "Save working values of ip/gw/dns"
    for kind in ip gw
    do
        value=$(get_value $kind)
        test -n "$value" || { r=1; break; }
        file=/home/pi/.firewalla/run/saved_${kind}
        rm -f $file
        echo "$value" > $file || { r=1; break; }
    done

    if [[ -f /etc/resolv.conf ]]
    then
        /bin/cp -f /etc/resolv.conf /home/pi/.firewalla/run/saved_resolv.conf || r=1
    else
        r=1
    fi

    if [[ $r -eq 1 ]]
    then
        err "Invalid value in IP/GW/DNS detected, save nothing"
        rm -rf /home/pi/.firewalla/run/saved_*
    fi

    return $r
}

set_value() {
    kind=$1
    saved_value=$2
    case ${kind} in
        ip)
            /sbin/ip addr flush dev eth0 # flush legacy ips on eth0
            /sbin/ip addr replace ${saved_value} dev eth0
            ;;
        gw)
            /sbin/ip route replace default via ${saved_value} dev eth0 # upsert current default route
            ;;
    esac
}

restore_values() {
    r=0
    $LOGGER "Restore saved values of ip/gw/dns"
    for kind in ip gw
    do
        file=/home/pi/.firewalla/run/saved_${kind}
        [[ -e "$file" ]] || continue
        saved_value=$(cat $file)
        [[ -n "$saved_value" ]] || continue
        set_value $kind $saved_value || r=1
    done
    if [[ -e /home/pi/.firewalla/run/saved_resolv.conf ]]; then
        /bin/cp -f /home/pi/.firewalla/run/saved_resolv.conf /etc/resolv.conf
    else
        r=1
    fi
    sleep 3
    return $r
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
        ping -c1 -w3 $gw >/dev/null || sudo nmap -sP -PR $gw |grep "Host is up" &> /dev/null
    else
        return 1
    fi
}

dns_resolvable() {
    nslookup -timeout=10 github.com >/dev/null
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
        skip=$([ ! -z "$reboot" ] && 'skipped')
        echo "fail - reboot $skip"
        $LOGGER "FIREWALLA:FIX_NETWORK:failed to $message, even after restore, reboot $skip"
        if [ -z "$reboot" ]; then reboot_if_needed; fi
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

$LOGGER "FIRE_CHECK DONE ... "

save_values

exit $rc

