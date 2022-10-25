#!/bin/bash

if [[ -n $1 ]]; then
  sudo ethtool -s eth0 autoneg on speed $1 duplex full
  echo '*/1 * * * * ( [[ $(cat /sys/class/net/eth0/carrier) == "0" ]] || [[ $(cat /sys/class/net/eth0/speed) == $1 ]] || sudo ethtool -s eth0 autoneg on speed $1 duplex full )' > /home/pi/.firewalla/config/crontab/fwp_eth0_autoneg
else
  sudo ethtool -s eth0 autoneg on
  rm -f /home/pi/.firewalla/config/crontab/fwp_eth0_autoneg
fi
bash /home/pi/firewalla/scripts/update_crontab.sh
