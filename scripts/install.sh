#!/bin/bash

# This script is to install Firewalla on a native ubuntu OS image
# (Beta)

function perr_and_exit()
{
  echo "$1" >&2
  exit 1
}

if [[ ! $(whoami) =~ "root" ]]; then
  echo "This script requires root privilege!"
  exit 1
fi

# Setup Account
useradd pi -m -s /bin/bash
usermod --password ZxgKFnDhJ7fbM pi
echo "pi  ALL=(ALL:ALL) NOPASSWD:ALL" >> /etc/sudoers

# Hostname
echo "Firewalla" > /etc/hostname
sed -i"" "s=127.0.0.1.*=127.0.0.1\tFirewalla localhost=" /etc/hosts
sed -i"" "s=::1=::1\tFirewalla localhost=" /etc/hosts

# Disable Root SSH Login
sed -i'' 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
service sshd restart

# Disable DNSMASQ config in NetworkManager
if [[ -e /etc/NetworkManager/NetworkManager.conf ]]; then
  sed -i"" "s/dns=dnsmasq/#dns=dnsmasq/" /etc/NetworkManager/NetworkManager.conf
  service NetworkManager restart
fi

# Remove all 3rd party apt source
# rm -fr /etc/apt/sources.list.d/*

# APT
apt-get update
apt-get upgrade

# NODE
echo "export NODE_PATH=/home/pi/.node_modules:$NODE_PATH" >> /etc/environment

# Firewalla
apt-get install -y git

if [ -z ${TRAVIS+x} ]; then
    sudo -u pi git clone https://github.com/firewalla/firewalla --branch release_pi_3_0 --single-branch
  
else
    ln -s $TRAVIS_BUILD_DIR /home/pi/firewalla
    sudo chmod 777 -R /home/*
fi

cd /home/pi/firewalla/
sudo -u pi ./buildraw4

# Cleanup
apt-get autoremove
apt-get clean
rm ~pi/.ssh/known_hosts 
> ~pi/.bash_history

# remove last logs
> /var/log/wtmp
> /var/log/btmp

sudo -u pi mkdir -p /home/pi/logs/

