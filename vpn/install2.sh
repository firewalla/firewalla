#!/bin/bash
# Generate OpenVPN server certificates and key chains for specific server instance
# install2.sh <instance_name>

: ${FIREWALLA_HOME:=/home/pi/firewalla}

INSTANCE_NAME=$1
: ${KEYS_FOLDER:=keys}

source ${FIREWALLA_HOME}/platform/platform.sh

# Ask user for desired level of encryption
: ${ENCRYPT:="1024"}

if [ -f /etc/openvpn/easy-rsa/$KEYS_FOLDER/ca.key ]; then
  if [ -f /etc/openvpn/easy-rsa/$KEYS_FOLDER/ta.key ]; then
    if [ -f /etc/openvpn/easy-rsa/$KEYS_FOLDER/$INSTANCE_NAME.crt ]; then
      if [ -f /etc/openvpn/easy-rsa/$KEYS_FOLDER/dh$ENCRYPT.pem ]; then
        logger "FIREWALLA: OpenVPN Setup Install Already Done for $INSTANCE_NAME"
        sudo chmod 755 -R /etc/openvpn
        exit 0
      fi
    fi
  fi
fi


if [[ ${KEYS_FOLDER} == "keys" ]]; then
  rm -r -f /etc/openvpn
  if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
    sudo rm -rf /home/pi/openvpn/*
    sudo ln -s /home/pi/openvpn /etc/openvpn
  else
    mkdir /etc/openvpn
  fi
  cp -r /usr/share/easy-rsa /etc/openvpn
  sync

fi

# Edit the EASY_RSA variable in the vars file to point to the new easy-rsa directory,
# And change from default 1024 encryption if desired
cd /etc/openvpn/easy-rsa
sed -i 's:"`pwd`":"/etc/openvpn/easy-rsa":' vars
if [ $ENCRYPT = 1024 ]; then
 sed -i 's:KEY_SIZE=2048:KEY_SIZE=1024:' vars
fi

sudo chmod 777 -R /etc/openvpn
cd /etc/openvpn/easy-rsa

# source the vars file just edited
source ./vars
export KEY_DIR="$EASY_RSA/$KEYS_FOLDER"
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
mkdir -p /home/pi/ovpns
sudo chown pi /home/pi/ovpns -R

# Generate static HMAC key to defend against DDoS
openvpn --genkey --secret $KEYS_FOLDER/ta.key
touch /etc/openvpn/multi_profile_support
sudo chmod 755 -R /etc/openvpn
sync
