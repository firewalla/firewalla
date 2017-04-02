#!/bin/bash -
DEFAULT_ROUTE=$(ip route show default | awk '/default/ {print $3}')

for i in `seq 1 3`; do
    if ping -c 1 $DEFAULT_ROUTE &> /dev/null
    then
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
   sync
   echo "SHOULD REBOOT"
   #/home/pi/firewalla/scripts/fire-reboot 
fi


