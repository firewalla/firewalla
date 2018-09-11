#!/bin/bash
# Generate OpenVPN server config file for specific server instance
# confgen.sh <instance_name> <local_ip> <dns> <server_network> <local_port>

: ${FIREWALLA_HOME:=/home/pi/firewalla}

INSTANCE_NAME=$1
LOCAL_IP=$2
DNS=$3
: ${DNS:="8.8.8.8"}
SERVER_NETWORK=$4
: ${SERVER_NETWORK="10.8.0.0"}
LOCAL_PORT=$5
: ${LOCAL_PORT="1194"}

if [ -f /etc/openvpn/$INSTANCE_NAME.conf ]; then
  # make sure that server config with same instance name, server network and local port
  # will not be regenerated
  grep -q "server $SERVER_NETWORK" /etc/openvpn/$INSTANCE_NAME.conf
  same_network=$?
  grep -q "port $LOCAL_PORT" /etc/openvpn/$INSTANCE_NAME.conf
  same_port=$?
  minimumsize=100
  actualsize=$(wc -c <"/etc/openvpn/$INSTANCE_NAME.conf")
  if [[ $same_network -eq 0 && $same_port -eq 0 && $actualsize -ge $minimumsize ]]; then
    logger "FIREWALLA: OpenVPN Config Already Done for $INSTANCE_NAME"
    exit 0
  fi
fi

# Ask user for desired level of encryption
ENCRYPT="1024"

# Write config file for server using the template .txt file
sed 's/LOCAL_IP/'$LOCAL_IP'/' < $FIREWALLA_HOME/vpn/server_config.txt > /etc/openvpn/$INSTANCE_NAME.conf
# Set DNS
sed -i "s=MY_DNS=$DNS=" /etc/openvpn/$INSTANCE_NAME.conf
# sed 's/MYDNS/'$DNS'/' <$FIREWALLA_HOME/vpn/server_config.txt.tmp >/etc/openvpn/server.conf
# Set server network
sed -i "s=SERVER_NETWORK=$SERVER_NETWORK=" /etc/openvpn/$INSTANCE_NAME.conf
# Set local port
sed -i "s=LOCAL_PORT=$LOCAL_PORT=" /etc/openvpn/$INSTANCE_NAME.conf
# Set server instance
sed -i "s/SERVER_INSTANCE/$INSTANCE_NAME/" /etc/openvpn/$INSTANCE_NAME.conf

if [ $ENCRYPT = 2048 ]; then
 sed -i 's:dh1024:dh2048:' /etc/openvpn/$INSTANCE_NAME.conf
fi
sync