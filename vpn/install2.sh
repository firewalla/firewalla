#!/bin/bash
# Generate OpenVPN server certificates and key chains for specific server instance
# install2.sh <instance_name>

: ${FIREWALLA_HOME:=/home/pi/firewalla}

INSTANCE_NAME=$1

if [ -f /etc/openvpn/easy-rsa/keys/ca.key ]; then
  if [ -f /etc/openvpn/easy-rsa/keys/ta.key ]; then
    if [ -f /etc/openvpn/easy-rsa/keys/$INSTANCE_NAME.crt ]; then
      logger "FIREWALLA: OpenVPN Setup Install Already Done for $INSTANCE_NAME"
      exit 0
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

# Make directory under home directory for .ovpn profiles
mkdir -p ~/ovpns
chmod 777 -R ~/ovpns

# Generate static HMAC key to defend against DDoS
openvpn --genkey --secret keys/ta.key
sync
