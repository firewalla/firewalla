#!/bin/bash
# Generate OpenVPN server config file for specific server instance
# confgen.sh <instance_name> <local_ip> <dns> <server_network> <local_port>

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

INSTANCE_NAME=$1
LOCAL_IP=$2
DNS=$3
: ${DNS:="8.8.8.8"}
SERVER_NETWORK=$4
: ${SERVER_NETWORK:="10.8.0.0"}
NETMASK=$5
: ${NETMASK:="255.255.255.0"}
LOCAL_PORT=$6
: ${LOCAL_PORT:="1194"}
PROTO=$7
: ${PROTO:="udp"}

chmod 777 -R /etc/openvpn

OPENSSL_CNF=$(get_openssl_cnf_file)
# Ensure nextUpdate in openssl crl to 3600 days
if [ -f $OPENSSL_CNF ]; then
  sudo sed -i 's/default_crl_days= [0-9]*/default_crl_days= 3600/' $OPENSSL_CNF
fi

if [ ! -s /etc/openvpn/crl.pem ]; then
  # create crl file with dummy revocation list
  cd /etc/openvpn/easy-rsa
  source ./vars
  ./pkitool dummy
  ./revoke-full dummy
  cp keys/crl.pem ../crl.pem
  cd -
fi

crl_expr=$(date -d "$(openssl crl -in /etc/openvpn/crl.pem -noout -nextupdate | cut -d= -f2)" +%s)
current_time=$(date +%s)
crl_expr_days_left=$((($crl_expr - $current_time) / 86400))
logger "CRL expiration days left: $crl_expr_days_left"

if [[ $crl_expr_days_left -lt 30 ]]; then
  # refresh crl next update time by create and revoke dummy certificate. The new crl next update time should be 3600 days later
  cd /etc/openvpn/easy-rsa
  source ./vars
  ./pkitool dummy
  ./revoke-full dummy
  cp keys/crl.pem ../crl.pem
  cd - 
fi

if [ ! -d /etc/openvpn/client_conf ]; then
  # create client config dir
  mkdir -p /etc/openvpn/client_conf
fi

cp $FIREWALLA_HOME/vpn/client_conf.txt /etc/openvpn/client_conf/DEFAULT

chmod 755 -R /etc/openvpn
chmod 644 /etc/openvpn/crl.pem
chmod 644 /etc/openvpn/client_conf/*

# Ask user for desired level of encryption
: ${ENCRYPT:="1024"}

# Write config file for server using the template .txt file
sed 's/LOCAL_IP/'$LOCAL_IP'/' < $FIREWALLA_HOME/vpn/server_config.txt > /etc/openvpn/$INSTANCE_NAME.conf
# Set DNS
sed -i "s=MY_DNS=$DNS=" /etc/openvpn/$INSTANCE_NAME.conf
# sed 's/MYDNS/'$DNS'/' <$FIREWALLA_HOME/vpn/server_config.txt.tmp >/etc/openvpn/server.conf
# Set server network
sed -i "s=SERVER_NETWORK=$SERVER_NETWORK=" /etc/openvpn/$INSTANCE_NAME.conf
# Set netmask
sed -i "s=NETMASK=$NETMASK=" /etc/openvpn/$INSTANCE_NAME.conf
# Set local port
sed -i "s=LOCAL_PORT=$LOCAL_PORT=" /etc/openvpn/$INSTANCE_NAME.conf
# Set server instance
sed -i "s/SERVER_INSTANCE/$INSTANCE_NAME/" /etc/openvpn/$INSTANCE_NAME.conf
# Set protocol, tcp6 or udp6, this also listens on ipv4 stack
sed -i "s/PROTO/${PROTO}6/" /etc/openvpn/$INSTANCE_NAME.conf

if [ $ENCRYPT = 2048 ]; then
 sed -i 's:dh1024:dh2048:' /etc/openvpn/$INSTANCE_NAME.conf
fi

# platform specific confgen
hook_after_vpn_confgen "/etc/openvpn/$INSTANCE_NAME.conf"

logger "FIREWALLA: OpenVPN config complete @ $INSTANCE_NAME"
sync