#!/bin/bash
#
#    Copyright 2023 Firewalla Inc.
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

# the brace bracket makes sure that bash reads all lines before execution
{
: ${FIREWALLA_HOME:=/home/pi/firewalla}

[ -s $FIREWALLA_HOME/scripts/firelog ] && FIRELOG=$FIREWALLA_HOME/scripts/firelog || FIRELOG=/usr/bin/logger

FWFLAG="/home/pi/.firewalla/config/.no_auto_upgrade"
FRFLAG="/home/pi/.router/config/.no_auto_upgrade"

[[ -e $FWFLAG ]]
NOAUTOFW=$?
echo NOAUTOFW $NOAUTOFW
if [[ $NOAUTOFW -eq 0 ]]; then
  $FIRELOG -t local -m "FIREWALLA.UPGRADE.FORCE removing $FWFLAG"
  # redis-cli set sys:upgrade:restore_no_auto_fw 1
  rm $FWFLAG
fi

[[ -e $FRFLAG ]]
NOAUTOFR=$?
echo NOAUTOFR $NOAUTOFR
if [[ $NOAUTOFR -eq 0 ]]; then
  $FIRELOG -t local -m "FIREWALLA.UPGRADE.FORCE removing $FRFLAG"
  # redis-cli set sys:upgrade:restore_no_auto_fr 1
  rm $FRFLAG
fi

$FIREWALLA_HOME/scripts/fireupgrade_check.sh
$FIRELOG -t local -m "FIREWALLA.UPGRADE.FORCE fireupgrade done"

if [[ $NOAUTOFW -eq 0 ]]; then
  $FIRELOG -t local -m "FIREWALLA.UPGRADE.FORCE adding back $FWFLAG"
  touch $FWFLAG
fi
if [[ $NOAUTOFR -eq 0 ]]; then
  $FIRELOG -t local -m "FIREWALLA.UPGRADE.FORCE adding back $FRFLAG"
  touch $FRFLAG
fi
}; exit
