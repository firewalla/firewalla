#!/bin/bash

#find /home/pi/firewalla/bin -name "bitb*" -type f -exec sudo setcap cap_net_admin,cap_net_raw=eip {} \;
sudo service redis-server start
