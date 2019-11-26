#!/bin/bash

#
#    Copyright 2017 - 2019 Firewalla INC
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

# 
#  this is the post soft upgrade script. It should contain anything that will
#  prevent a reboot 
#

sudo cp /home/pi/firewalla/etc/bitbridge4.service /etc/systemd/system/.
sudo cp /home/pi/firewalla/etc/bitbridge6.service /etc/systemd/system/.

