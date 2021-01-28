#!/bin/bash

#
#    Copyright 2021 Firewalla Inc.
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

# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------
STATE_TYPE='service'

check_each_system_service() {
  service_name=$1
  state_expected=$2
  state_actual=$(sudo systemctl is-active $service_name)
  test  "$state_actual" == "$state_expected"; _rc1=$?
  echo "state $STATE_TYPE $service_name $_rc1 state_actual=$state_actual state_expected=$state_expected"
  return $_rc1
}

check_services() {
    _rc=0
    check_each_system_service fireapi "active" || _rc=1
    check_each_system_service firemain "active" || _rc=1
    check_each_system_service firemon "active" || _rc=1
    check_each_system_service firekick "inactive" || _rc=1
    check_each_system_service redis-server "active" || _rc=1
    check_each_system_service brofish "active" || _rc=1
    check_each_system_service firewalla "inactive" || _rc=1
    check_each_system_service fireupgrade "inactive" || _rc=1
    check_each_system_service fireboot "inactive" || _rc=1

    vpn_state=$(redis-cli hget policy:system vpn | jq .state)
    $vpn_state && vpn_run_state='active' || vpn_run_state='inactive'
    check_each_system_service openvpn@server $vpn_run_state || _rc=1

    if [[ $PLATFORM != 'gold' ]]; then # non gold
        check_each_system_service firemasq "active" || _rc=1
        check_each_system_service watchdog "active" || _rc=1
    else # gold
        check_each_system_service firerouter "active" || _rc=1
        check_each_system_service firerouter_dns "active" || _rc=1
        check_each_system_service firerouter_dhcp "active" || _rc=1
    fi
    return $_rc
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

rc=0
case "$(uname -m)" in
  "x86_64")
    PLATFORM='gold'
    ;;
  "aarch64")
    if [[ -e /etc/firewalla-release ]]; then
      PLATFORM=$( . /etc/firewalla-release 2>/dev/null && echo $BOARD || cat /etc/firewalla-release )
    else
      PLATFORM='unknown'
    fi
    ;;
  "armv7l")
    PLATFORM='red'
    ;;
  *)
    PLATFORM='unknown'
    ;;
esac


check_services || rc=1


exit $rc
