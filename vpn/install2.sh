#!/bin/bash

if [ -f /etc/openvpn/easy-rsa/keys/ca.key ]; then
   exit 0;
fi

: ${FIREWALLA_HOME:=/home/pi/firewalla}
LOCALIP=$1
PUBLICIP=$2
DNS=$3
: ${DNS:="8.8.8.8"}
# Ask user for desired level of encryption
ENCRYPT="1024"
# Copy the easy-rsa files to a directory inside the new openvpn directory
rm -r -f /etc/openvpn
mkdir /etc/openvpn
cp -r /usr/share/easy-rsa /etc/openvpn

# Edit the EASY_RSA variable in the vars file to point to the new easy-rsa directory,
# And change from default 1024 encryption if desired
cd /etc/openvpn/easy-rsa
sed -i 's:"`pwd`":"/etc/openvpn/easy-rsa":' vars
if [ $ENCRYPT = 1024 ]; then
 sed -i 's:KEY_SIZE=2048:KEY_SIZE=1024:' vars
fi

# source the vars file just edited
source ./vars

# Remove any previous keys
./clean-all

# Build the certificate authority
./build-ca < $FIREWALLA_HOME/vpn/ca_info.txt

# Build the server
#./build-key-server server
echo "build-key-server"
./pkitool --server server

# Generate Diffie-Hellman key exchange
echo "build-dh"
./build-dh

# Generate static HMAC key to defend against DDoS
openvpn --genkey --secret keys/ta.key

# Write config file for server using the template .txt file
sed 's/LOCALIP/'$LOCALIP'/' <$FIREWALLA_HOME/vpn/server_config.txt > $FIREWALLA_HOME/vpn/server_config.txt.tmp
# Set DNS
sed 's/MYDNS/'$DNS'/' <$FIREWALLA_HOME/vpn/server_config.txt.tmp >/etc/openvpn/server.conf
if [ $ENCRYPT = 2048 ]; then
 sed -i 's:dh1024:dh2048:' /etc/openvpn/server.conf
fi


# Write default file for client .ovpn profiles, to be used by the MakeOVPN script, using template .txt file
sed 's/PUBLICIP/'$PUBLICIP'/' <$FIREWALLA_HOME/vpn/Default.txt >/etc/openvpn/easy-rsa/keys/Default.txt



# Make directory under home directory for .ovpn profiles
mkdir -p ~/ovpns
chmod 777 -R ~/ovpns
