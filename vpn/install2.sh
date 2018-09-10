#!/bin/bash
# Generate OpenVPN server config file for specific server instance
# install2.sh <instance_name> <local_ip> <dns> <server_network> <local_port>

: ${FIREWALLA_HOME:=/home/pi/firewalla}

INSTANCE_NAME=$1
LOCAL_IP=$2
DNS=$3
: ${DNS:="8.8.8.8"}
SERVER_NETWORK=$4
: ${SERVER_NETWORK="10.8.0.0"}
LOCAL_PORT=$5
: ${LOCAL_PORT="1194"}

if [ -f /etc/openvpn/easy-rsa/keys/ca.key ]; then
  if [ -f /etc/openvpn/easy-rsa/keys/ta.key ]; then
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
        logger "FIREWALLA: OpenVPN Setup Install Already Done for $INSTANCE_NAME"
        exit 0
      fi
    fi
  fi
fi


# Ask user for desired level of encryption
ENCRYPT="1024"
# Copy the easy-rsa files to a directory inside the new openvpn directory
rm -r -f /etc/openvpn
mkdir /etc/openvpn
cp -r /usr/share/easy-rsa /etc/openvpn
sync

# Edit the EASY_RSA variable in the vars file to point to the new easy-rsa directory,
# And change from default 1024 encryption if desired
cd /etc/openvpn/easy-rsa
sed -i 's:"`pwd`":"/etc/openvpn/easy-rsa":' vars
if [ $ENCRYPT = 1024 ]; then
 sed -i 's:KEY_SIZE=2048:KEY_SIZE=1024:' vars
fi

# source the vars file just edited
source ./vars
sync

# Remove any previous keys
./clean-all

# Build the certificate authority
./build-ca < $FIREWALLA_HOME/vpn/ca_info.txt

# Build the server
#./build-key-server server
echo "build-key-server"
./pkitool --server $INSTANCE_NAME
sync

# Generate Diffie-Hellman key exchange
echo "build-dh"
./build-dh


# Write config file for server using the template .txt file
sed 's/LOCAL_IP/'$LOCAL_IP'/' <$FIREWALLA_HOME/vpn/server_config.txt > /etc/openvpn/$INSTANCE_NAME.conf
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

# Make directory under home directory for .ovpn profiles
mkdir -p ~/ovpns
chmod 777 -R ~/ovpns

# Generate static HMAC key to defend against DDoS
openvpn --genkey --secret keys/ta.key
sync
