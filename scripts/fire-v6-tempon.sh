sudo service bitbridge6 stop
cp /home/pi/firewalla/bin/real/bitbridge6 /home/pi/firewalla/bin/bitbridge6
sudo setcap cap_net_admin,cap_net_raw=eip $FIREWALLA_HOME/bin/bitbridge6
sudo service bitbridge6 start
