#! /usr/bin/env bash


pwd
echo $NODE_PATH
sudo mkdir -p /home/pi
sudo ln -sfn /home/runner/work/firewalla/firewalla /home/pi/firewalla
sudo ls -l /home/pi/firewalla

# One resolution pass for the whole set. Installing these one at a time made npm
# re-resolve and re-audit the entire ~580 package tree seven times over, which is
# where most of this job's runtime went. mocha is a devDependency and npm scripts
# put node_modules/.bin on PATH, so it no longer needs a separate global install.
npm i \
  nyc@15.1.0 \
  mocha@^9.2.2 \
  jsbn@1.1.0 \
  lru-cache@5.1.1 \
  moment-timezone@0.3.1 \
  muk@0.5.3 \
  async@2.6.4

sudo touch /etc/firewalla-release
sudo bash -c 'cat <<EOF > /etc/firewalla-release
BOARD=gold
BOARD_NAME=gold
BOARD_VENDOR=Firewalla
ARCH=x86_64"
EOF'

HOME='/home/pi'
mkdir -p ${HOME}/.firewalla/run/device-detector-regexes
mkdir -p ${HOME}/.firewalla/config/dnsmasq
mkdir -p ${HOME}/.forever
mkdir -p ${HOME}/ovpns
mkdir -p ${HOME}/logs
mkdir -p ./coverage
echo "{}" > ${HOME}/.firewalla/license
sudo apt-get install -y redis ipset
