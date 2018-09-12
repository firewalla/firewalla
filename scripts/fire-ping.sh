#!/bin/bash -

# Check Memory as well here, if memory is low don't write ...
#
# this should deal with /dev/watchdog

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

mem=0

swapmem=$(free -m | awk '/Swap:/{print $4}')
realmem=$(free -m | awk '/Mem:/{print $7}')
totalmem=$(( swapmem + realmem ))

if [[ -n "$swapmem" && $swapmem -gt 0 ]]; then
  mem=$totalmem
  (( mem <= $MIN_FREE_MEMORY )) && echo fireapi swap $mem >> /home/pi/.forever/top_before_reboot.log
else
  mem=$realmem
  (( mem <= $MIN_FREE_MEMORY )) && echo fireapi real mem $mem >> /home/pi/.forever/top_before_reboot.log
fi

(( mem <= 0 )) && mem=$(free -m | awk '/Mem:/{print $7}')
(( mem <= $MIN_FREE_MEMORY )) && /home/pi/firewalla/scripts/firelog -t local -m "REBOOT: Memory less than $MIN_FREE_MEMORY $mem"
(( mem <= $MIN_FREE_MEMORY )) && /home/pi/firewalla/scripts/free-memory-lastresort 

#DEFAULT_ROUTE=$(ip route show default | awk '/default/ {print $3}')
DEFAULT_ROUTE=$(ip r |grep eth0 | grep default | cut -d ' ' -f 3 | sed -n '1p')

touch /tmp/watchdog 

for i in `seq 1 10`; do
    if ping -w 1 -c 1 $DEFAULT_ROUTE &> /dev/null || sudo nmap -sP -PR $DEFAULT_ROUTE |grep "Host is up" &> /dev/null
    then
#      /home/pi/firewalla/scripts/firelog -t debug -m"FIREWALLA PING WRITE"
       exit 0
    else
      echo "Ping Failed"
      /home/pi/firewalla/scripts/firelog -t debug -m "FIREWALLA PING NO Local Network $DEFAULT_ROUTE"
      sleep 1
      touch /tmp/watchdog 
    fi
done

# if there is api process running, we have likely lost connection ...
# reboot ...

api_process_cnt=`sudo systemctl status fireapi |grep 'active (running)' | wc -l`
if [[ $api_process_cnt > 0 && ! -e /home/pi/.firewalla/config/disable_no_network_reboot ]]; then
   /home/pi/firewalla/scripts/firelog -t cloud -m "REBOOT: FIREWALLA PING NO Local Network REBOOT "
   /home/pi/firewalla/scripts/fire-rebootf 
   exit 0
fi

FOUND=`grep "eth0:" /proc/net/dev`
if [ -n "$FOUND" ] ; then
   echo found
else
  if [[ ! -e /home/pi/.firewalla/config/disable_no_eth0_reboot ]]; then
    /home/pi/firewalla/scripts/firelog -t cloud -m "REBOOT: FIREWALLA PING MISSING ETH0 Local Network REBOOT "
    /home/pi/firewalla/scripts/fire-rebootf 
  fi
  exit 0
fi

/home/pi/firewalla/scripts/firelog -t debug -m "FIREWALLA PING WRITE2"

touch /tmp/watchdog 

