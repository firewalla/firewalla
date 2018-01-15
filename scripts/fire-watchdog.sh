#!/bin/bash -

# Check Memory as well here, if memory is low don't write ...
#
# this should deal with /dev/watchdog

mem=0

swapmem=$(free -m | awk '/Swap:/{print $4}')
realmem=$(free -m | awk '/Mem:/{print $7}')
totalmem=$(( swapmem + realmem ))

(( mem <= 0 )) && mem=$(free -m | awk '/Mem:/{print $7}')
(( mem <= 35 )) && /home/pi/firewalla/scripts/firelog -t local -m "REBOOT: Memory less than 35 $mem"

#DEFAULT_ROUTE=$(ip route show default | awk '/default/ {print $3}')
DEFAULT_ROUTE=$(ip r |grep eth0 | grep default | cut -d ' ' -f 3 | sed -n '1p')

for i in `seq 1 1`; do
    if ping -w 1 -c 1 $DEFAULT_ROUTE &> /dev/null
    then
#      /home/pi/firewalla/scripts/firelog -t debug -m"FIREWALLA PING WRITE"
       echo "Ping Good"
    else
       echo "Ping Failed"
    fi
done

#sudo touch /dev/watchdog
# if there is api process running, we have likely lost connection ...
# reboot ...
