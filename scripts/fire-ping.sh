#!/bin/bash -

# Check Memory as well here, if memory is low don't write ...
#
# this should deal with /dev/watchdog

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
  exit 0
fi

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
DEFAULT_ROUTE=$(ip r | grep default | cut -d ' ' -f 3 | sed -n '1p')

touch /tmp/watchdog 

for i in `seq 1 10`; do
    if ping -w 1 -c 1 $DEFAULT_ROUTE &> /dev/null || sudo timeout 1200s nmap -sP -PR $DEFAULT_ROUTE |grep "Host is up" &> /dev/null
    then
#      /home/pi/firewalla/scripts/firelog -t debug -m"FIREWALLA PING WRITE"
       exit 0
    else
      BACKUP_DOMAIN="firewalla.com"
      if [ $((i % 2)) -eq 0 ]; then
        BACKUP_DOMAIN="github.com"
      fi
      echo "Ping gateway failed. Trying backup domain $BACKUP_DOMAIN..."
      if ping -w 3 -c 1 $BACKUP_DOMAIN &> /dev/null 
      then
        exit 0
      else
        echo "Ping backup domain $BACKUP_DOMAIN failed. Trying curl instead ..."
        if timeout 10 curl -s "https://$BACKUP_DOMAIN" &> /dev/null
        then
          exit 0
        else
          /home/pi/firewalla/scripts/firelog -t debug -m "FIREWALLA PING NO Local Network $DEFAULT_ROUTE"
          sleep 1
          touch /tmp/watchdog 
        fi
      fi
    fi
done

# if there is api process running, we have likely lost connection ...
# reboot ...

api_process_cnt=`sudo systemctl status fireapi |grep 'active (running)' | wc -l`
if [[ $api_process_cnt -gt 0 && ! -e /home/pi/.firewalla/config/disable_no_network_reboot ]]; then
   /home/pi/firewalla/scripts/firelog -t cloud -m "REBOOT: FIREWALLA PING NO Local Network REBOOT "
   /home/pi/firewalla/scripts/fire-rebootf 
   exit 0
fi

FOUND=`grep "eth.*:" /proc/net/dev`
if [ -n "$FOUND" ] ; then
   echo found
else
  if [[ ! -e /home/pi/.firewalla/config/disable_no_eth0_reboot ]]; then
    /home/pi/firewalla/scripts/firelog -t cloud -m "REBOOT: FIREWALLA PING MISSING ETH Local Network REBOOT "
    /home/pi/firewalla/scripts/fire-rebootf 
  fi
  exit 0
fi

/home/pi/firewalla/scripts/firelog -t debug -m "FIREWALLA PING WRITE2"

touch /tmp/watchdog 

