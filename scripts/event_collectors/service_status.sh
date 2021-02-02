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
: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

check_each_system_service() {
  service_name=$1
  state_expected=$2
  state_actual=$(sudo systemctl is-active $service_name)
  test  "$state_actual" == "$state_expected"
  echo "state $STATE_TYPE $service_name $? state_actual=$state_actual state_expected=$state_expected"
}

check_services() {
    check_each_system_service fireapi "active"
    check_each_system_service firemain "active"
    check_each_system_service firemon "active"
    check_each_system_service firekick "inactive"
    check_each_system_service redis-server "active"
    check_each_system_service brofish "active"
    check_each_system_service firewalla "inactive"
    check_each_system_service fireupgrade "inactive"
    check_each_system_service fireboot "inactive"

    if redis-cli hget policy:system vpn | fgrep -q '"state":true'
    then
      vpn_run_state='active'
    else
      vpn_run_state='inactive'
    fi
    check_each_system_service openvpn@server $vpn_run_state

    if [[ $MANAGED_BY_FIREROUTER == 'yes' ]]; then
        check_each_system_service firerouter "active"
        check_each_system_service firerouter_dns "active"
        check_each_system_service firerouter_dhcp "active"
    else
        check_each_system_service firemasq "active"
        check_each_system_service watchdog "active"
    fi
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

check_services

