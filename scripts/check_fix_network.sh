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

SLEEP_INTERVAL=${SLEEP_INTERVAL:-1}
LOGGER=/usr/bin/logger

err() {
    msg="$@"
    echo "ERROR: $msg" >&2
    /home/pi/firewalla/scripts/firelog -t local -m "FIREWALLA.UPGRADE.ERROR $msg"
}

get_value() {
    kind=$1
    case $kind in
        ip)
            /sbin/ip addr show dev eth0 | awk '$NF=="eth0" {print $2}' | fgrep -v 169.254. | fgrep -v -w 192.168.218.1 | fgrep -v -w 0.0.0.0 | fgrep -v -w 255.255.255.255
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
            /sbin/ip addr replace ${saved_value} dev eth0
            ;;
        gw)
            /sbin/route add default gw ${saved_value} eth0
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
    eth_ip=$(ip addr show dev eth0 | awk '/inet / {print $2}'|cut -f1 -d/)
    if [[ -n "$eth_ip" ]]; then
        if [[ ${eth_ip:0:8} == '169.254.' ]]; then
            return 1
        elif [[ $eth_ip == '192.168.218.1' ]]; then
            return 1
        else
            return 0
        fi
    else
        return 1
    fi
}

gateway_pingable() {
    gw=$(ip route show dev eth0 | awk '/default/ {print $3; exit; }')
    if [[ -n "$gw" ]]; then
        ping -c1 -w3 $gw >/dev/null
    else
        return 1
    fi
}

dns_resolvable() {
    nslookup -timeout=10 github.com >/dev/null
}

github_api_ok() {
    curl -L -m10 https://api.github.com/zen &> /dev/null
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

: ${CHECK_FIX_NETWORK_RETRY:='yes'}
while [[ -n $CHECK_FIX_NETWORK_RETRY ]]; do
    # only run once if requires NO retry
    test $CHECK_FIX_NETWORK_RETRY == 'no' && unset CHECK_FIX_NETWORK_RETRY
    echo -n "checking gateway ... "
    tmout=15
    while ! gateway_pingable; do
        if [[ $tmout -gt 0 ]]; then
            (( tmout-- ))
        else
            if [[ $restored -eq $NOT_RESTORED ]]; then
                echo "fail - restore"
                $LOGGER "failed to ping gateway, restore network configurations"
                restore_values
                restored=$RESTORED_AND_NEED_START_OVER
                break;
            else
                echo "fail - reboot"
                $LOGGER "FIREWALLA:FIX_NETWORK:failed to ping gateway, even after restore, reboot"
                reboot_if_needed
            fi
        fi
        sleep 1
    done
    if [[ $restored -eq $RESTORED_AND_NEED_START_OVER ]]; then
      restored=$RESTORED
      continue
    fi
    echo OK

    echo -n "checking DNS ... "
    tmout=15
    while ! dns_resolvable; do
        if [[ $tmout -gt 0 ]]; then
            (( tmout-- ))
        else
            if [[ $restored -eq $NOT_RESTORED ]]; then
                echo "fail - restore"
                $LOGGER "failed to resolve DNS, restore network configurations"
                restore_values
                restored=$RESTORED_AND_NEED_START_OVER
                break
            else
                echo "fail - reboot"
                $LOGGER "FIREWALLA:FIX_NETWORK:failed to resolve DNS, even after restore, reboot"
                reboot_if_needed
            fi
        fi
        sleep 1
    done
    if [[ $restored -eq $RESTORED_AND_NEED_START_OVER ]]; then
      restored=$RESTORED
      continue
    fi
    echo OK

    echo -n "checking github REST API ... "
    tmout=15
    while ! github_api_ok; do
        if [[ $tmout -gt 0 ]]; then
            (( tmout-- ))
        else
            if [[ $restored -eq $NOT_RESTORED ]]; then
                echo "fail - restore"
                $LOGGER "failed to reach github API, restore network configurations"
                restore_values
                restored=$RESTORED_AND_NEED_START_OVER
                break
            else
                $LOGGER "FIREWALLA:FIX_NETWORK:failed to reach github API, even after restore, reboot"
                echo "fail - reboot"
# comment out on purpose                reboot_if_needed
            fi
        fi
        sleep 1
    done
    if [[ $restored -eq $RESTORED_AND_NEED_START_OVER ]]; then
      restored=$RESTORED
      continue
    fi
    echo OK

    break

done

$LOGGER "FIRE_CHECK DONE ... "

save_values

exit $rc

