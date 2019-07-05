#!/bin/bash

sudo chmod 777 -R /etc/openvpn
if [[ -e /etc/openvpn/easy-rsa/keys ]] && [[ $(uname -m) == "aarch64" ]] && ! [[ -e /etc/openvpn/multi_profile_support ]]; then
  bash $FIREWALLA_HOME/scripts/reset-vpn-keys.sh
fi 

if [ ! -s /etc/openvpn/crl.pem ]; then
  # create crl file with dummy revocation list
  cd /etc/openvpn/easy-rsa

  # Change nextUpdate in openssl crl to 3600 days
  if [ -f /etc/openvpn/easy-rsa/openssl-1.0.0.cnf ]; then
    sudo sed -i 's/default_crl_days= [0-9]*/default_crl_days= 3600/' /etc/openvpn/easy-rsa/openssl-1.0.0.cnf
  fi
  source ./vars
  ./pkitool dummy
  ./revoke-full dummy
  cp keys/crl.pem ../crl.pem
  cd -  
fi

crl_expr=$(date -d "$(openssl crl -in /etc/openvpn/crl.pem -noout -nextupdate | cut -d= -f2)" +%s)
current_time=$(date +%s)
crl_expr_days_left=$((($crl_expr - $current_time) / 86400))

if [[ $crl_expr_days_left -lt 30 ]]; then
  # refresh crl next update time by create and revoke dummy certificate. The new crl next update time should be 3600 days later
  cd /etc/openvpn/easy-rsa
  source ./vars
  ./pkitool dummy
  ./revoke-full dummy
  cp keys/crl.pem ../crl.pem
  cd - 
fi

if [ -f /etc/openvpn/server.conf ]; then
  grep -q -w "crl-verify" /etc/openvpn/server.conf
  crl_enabled=$?
  if [[ $crl_enabled -ne 0 ]]; then
    # ensure crl-verify is enabled in server config
    echo -e "\ncrl-verify /etc/openvpn/crl.pem" >> /etc/openvpn/server.conf
  fi
  grep -q -w "client-config-dir" /etc/openvpn/server.conf
  ccd_enabled=$?
  if [[ $ccd_enabled -ne 0 ]]; then
    # ensure client-config-dir is enabled in server config
    echo -e "\nclient-config-dir /etc/openvpn/client_conf" >> /etc/openvpn/server.conf
  fi
fi

if [ ! -d /etc/openvpn/client_conf ]; then
  # create client config dir
  mkdir -p /etc/openvpn/client_conf
fi

if [ ! -f /etc/openvpn/client_conf/DEFAULT ]; then
  sed 's/COMP_LZO_OPT/comp-lzo no/' < /home/pi/firewalla/vpn/client_conf.txt > /etc/openvpn/client_conf/DEFAULT
  sed -i 's/COMPRESS_OPT/compress/' /etc/openvpn/client_conf/DEFAULT
fi

#sudo chmod 600 -R /etc/openvpn
sudo chmod 777 /etc/openvpn
sudo chmod 644 /etc/openvpn/crl.pem
sudo chmod 777 /etc/openvpn/client_conf
sudo chmod 644 /etc/openvpn/client_conf/*

sudo cp /home/pi/firewalla/extension/vpnclient/openvpn_client@.service.template /etc/systemd/system/openvpn_client@.service
sudo systemctl daemon-reload
