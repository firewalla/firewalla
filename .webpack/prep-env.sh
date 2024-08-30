#! /usr/bin/env bash


pwd
echo $NODE_PATH
sudo mkdir -p /home/pi
sudo ln -s /home/runner/work/firewalla/firewalla /home/pi/firewalla
sudo ls -l /home/pi/firewalla

npm i nyc@15.1.0
npm i mocha@2.5.3
npm i jsbn@1.1.0
npm i lru-cache@5.1.1
npm i moment-timezone@0.3.1
npm i muk@0.5.3
npm i async@2.6.4

sudo touch /etc/firewalla-release
sudo bash -c 'cat <<EOF > /etc/firewalla-release
BOARD=gold
BOARD_NAME=gold
BOARD_VENDOR=Firewalla
ARCH=x86_64"
EOF'

mkdir -p ${HOME}/.firewalla/run/device-detector-regexes
mkdir -p ${HOME}/.firewalla/config/dnsmasq
mkdir -p ${HOME}/ovpns
mkdir -p ${HOME}/logs
mkdir -p ./coverage
echo "{}" > ${HOME}/.firewalla/license
sudo apt-get install redis
sudo apt-get install ipset
