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

if [[ $(uname -m) == "x86_64" ]]; then
	exit 0
fi

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
            # read ip address of wan interface only
            wan_intf=`/sbin/ip route show | awk '/default via/ {print $5}' | head -n 1`
            if [[ -n "$wan_intf" ]]; then
              /sbin/ip addr show dev $wan_intf | awk '/inet /' | awk '$NF=='"\"$wan_intf\""' {print $2"---"'"\"$wan_intf\""'}' | fgrep -v 169.254. | fgrep -v -w 0.0.0.0 | fgrep -v -w 255.255.255.255 | head -n 1
            fi
            ;;
        gw)
            /sbin/ip route show | awk '/default via/ {print $3"---"$5}' | grep -oE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b\-\-\-.*"  | fgrep -v -w 0.0.0.0 | fgrep -v -w 255.255.255.255 | head -n 1
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
            # ip is like <ip_address>/<subnet_mask_length>---<intf_name>
            addr=`echo $saved_value | cut -d"---" -f1`
            intf=`echo $saved_value | cut -d"---" -f2`
            /sbin/ip addr flush dev $intf # flush legacy ips
            /sbin/ip addr replace ${addr} dev $intf
            ;;
        gw)
            # gw is like <ip_address>---<intf_name>
            addr=`echo $saved_value | cut -d"---" -f1`
            intf=`echo $saved_value | cut -d"---" -f2`
            /sbin/ip route replace default via ${addr} dev $intf # override current default route
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

gateway_pingable() {
    gw=$(ip route show | awk '/default/ {print $3; exit; }' | head -n 1)
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
    curl -L -m10 https://api.github.com/zen &> /dev/null || nc -z 1.1.1.1 443 &> /dev/null
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

