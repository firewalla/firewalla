#!/bin/bash -
: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

# Check Memory as well here, if memory is low don't write ...
#
# this should deal with /dev/watchdog
mem=$(free -m | awk '/-/{print $4}')
(( mem <= 0 )) && mem=$(free -m | awk '/Mem:/{print $7}')
(( mem <= $REBOOT_FREE_MEMORY )) &&  exit 0

#DEFAULT_ROUTE=$(ip route show default | awk '/default/ {print $3}')
DEFAULT_ROUTE=$(ip r |grep eth0 | grep default | cut -d ' ' -f 3 | sed -n '1p')

for i in `seq 1 3`; do
    if ping -c 1 $DEFAULT_ROUTE &> /dev/null
    then
       sudo touch /dev/watchdog
       /usr/bin/logger "FIREWALLA PING WRITE"
       exit 0
    else
       echo "Ping Failed"
      /usr/bin/logger "FIREWALLA PING NO Local Network"
      sleep 1
    fi
done

# if there is api process running, we have likely lost connection ...
# reboot ...

api_process_cnt=`sudo systemctl status fireapi |grep 'active (running)' | wc -l`
if [[ $api_process_cnt > 0 ]]; then
   /usr/bin/logger "FIREWALLA PING NO Local Network REBOOT "
   #sync
   #/home/pi/firewalla/scripts/fire-reboot 
   exit 0
fi

sudo touch /dev/watchdog
/usr/bin/logger "FIREWALLA PING WRITE2"


