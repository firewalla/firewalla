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

get_value() {
    case $1 in
        ip)
            /sbin/ifconfig eth0 |grep 'inet addr'|awk '{print $2}' | awk -F: '{print $2}'
            ;;
        gw)
            /sbin/route -n | awk '$1=="0.0.0.0" {print $2}'
            ;;
        dns)
            dns_file=/etc/resolv.conf
            dns_bak=/etc/resolv.conf.firewalla
            if [[ -e $dns_file ]]
            then
                # file exists, show path of backup file
                echo $dns_bak
                # only backup if not done before
                [[ -e $dns_bak ]] || cp -a $dns_file $dns_bak
            else
                # file NOT exist - error
                echo ''
            fi
            ;;
    esac
}

set_value() {
    kind=$1
    saved_value=$2
    case ${kind} in
        ip)
            /sbin/ifconfig eth0 ${saved_value}
            ;;
        gw)
            /sbin/route add default gw ${saved_value} eth0
            ;;
        dns)
            bak_file=$saved_value
            [[ -e $bak_file ]] && cp -a /etc/resolv.conf{.firewalla,}
            ;;
    esac
}

check_fix_value() {
    kind=$1
    current_value=$(get_value $kind)
    saved_file="/var/run/saved_${kind}"
    r=0
    if [[ -n "$current_value" ]]
    then
        /bin/rm -f ${saved_file}
        echo ${current_value} > ${saved_file} || r=1
        logger "Current ${kind} detected(${current_value}), saved in ${saved_file}"
    elif [[ -f "${saved_file}" ]]
    then
        sleep ${SLEEP_INTERVAL}
        saved_value=$(cat ${saved_file})
        set_value ${kind} ${saved_value} || r=1
        logger "WARN:NO ${kind} detected, set to saved value - ${saved_value}"
    else
        r=1
        logger "ERROR:NO ${kind} and NO saved value detected."
    fi
    return $r
}

sleep ${SLEEP_INTERVAL}
for x in ip gw dns
do
    check_fix_value $x || rc=1
done

exit $rc
