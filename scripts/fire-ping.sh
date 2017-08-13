#!/bin/bash -

# Check Memory as well here, if memory is low don't write ...
#
# this should deal with /dev/watchdog
mem=$(free -m | awk '/-/{print $4}')
(( mem <= 0 )) && mem=$(free -m | awk '/Mem:/{print $7}')
(( mem <= 20 )) && logger "REBOOT: Memory less than 20 $mem"
(( mem <= 20 )) && /home/pi/firewalla/scripts/free-memory-lastresort 

#DEFAULT_ROUTE=$(ip route show default | awk '/default/ {print $3}')
DEFAULT_ROUTE=$(ip r |grep eth0 | grep default | cut -d ' ' -f 3 | sed -n '1p')

for i in `seq 1 5`; do
    if ping -c 1 $DEFAULT_ROUTE &> /dev/null
    then
#       sudo touch /dev/watchdog
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
   /usr/bin/logger "REBOOT: FIREWALLA PING NO Local Network REBOOT "
   /home/pi/firewalla/scripts/fire-rebootf 
   exit 0
fi

#sudo touch /dev/watchdog
/usr/bin/logger "FIREWALLA PING WRITE2"


