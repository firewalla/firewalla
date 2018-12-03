#!/bin/bash

function perr_and_exit() {
	echo "$1" >&2
	exit 1
}

function usage() {
	cat <<EOM
Usage: buildraw [-n] [-h]"
    -n      Skip apt dependency installations.
    -h      Show this help.
EOM
}

function setup_sys_env() {
	# Set firewalla global environment variable
	if ! grep "^FIREWALLA_HOME=" /etc/environment &>/dev/null; then
		echo "FIREWALLA_HOME "+$basedir
		sudo /bin/echo "FIREWALLA_HOME=$basedir" | sudo bash -c 'cat - >>  /etc/environment' || perr_and_exit "Failed to setup FIREWALLA_HOME env variable."
	fi

	# Set NODE_PATH
	if ! grep "^NODE_PATH=" /etc/environment &>/dev/null; then
		sudo echo "NODE_PATH=/home/pi/.node_modules" | sudo bash -c 'cat - >> /etc/environment' || perr_and_exit "Failed to add NODE_PATH env"
	fi

}

function install_dependencies() {
	git pull || perr_and_exit "Failed to pull latest firewalla code."

	# TODO: check local apt mirror
	echo "Installing node source repository..."
	curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.11/install.sh | bash
	export NVM_DIR="$HOME/.nvm"
	[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" # This loads nvm
	#[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
	export PATH=$PATH:/sbin
	nvm install 8.7.0

	#    sudo  curl -sL https://deb.nodesource.com/setup_8.x | sudo -E bash -   || perr_and_exit "Failed to install node source repo"

	echo "Executing apt-get update, please be patient..."
	sudo apt-get update || perr_and_exit "apt-get update failed."

	apt_pkg_list="wget net-tools curl redis-server iptables ca-certificates nmap dsniff bluetooth bluez libbluetooth-dev libudev-dev nodejs openvpn easy-rsa python-pip cron ntpdate ipset dhcpdump dnsmasq dnsutils nbtscan"

	echo "Installing dependencies, please be patient..."
	sudo apt-get install $apt_pkg_list -y || perr_and_exit "Failed to install needed packages."

	sudo -H pip install --upgrade pip
	sudo -H pip install setuptools

	if [[ -f /.dockerenv ]]; then
		echo "Setting special npm configuration for Docker enviornment..."
		# a workaround for npm/nodejs bug
		# https://github.com/npm/npm/issues/4719
		sudo npm config set unsafe-perm true
	fi

	echo "Installing tools: forever and xml-json..."
	sudo npm install forever -g
	sudo npm install xml-json -g

	echo "Setting up required folders and configures..."
	sudo mkdir -p /blog || perr_and_exit "Failed to create folder /blog"
	sudo mkdir -p /bspool || perr_and_exit "Failed to create folder /bspool"

	echo "Setting up openvpn..."
	sudo rm -r -f /etc/openvpn || perr_and_exit "Failed to delete existing openvpn configure folder."
	sudo mkdir -p /etc/openvpn || perr_and_exit "Failed to create new openvpn configure folder."
	sudo cp -r /usr/share/easy-rsa /etc/openvpn || perr_and_exit "Failed to copy easy_rsa."

	#echo "Installing shadowsocks..."
	#sudo -H pip install shadowsocks || perr_and_exit "Failed to install shadowsocks."
}

function install_walla() {
	echo "Installing node modules..."

	FW_NODE_MODULES_PATH=~/.node_modules
	branch=$(git rev-parse --abbrev-ref HEAD)
	CPU_PLATFORM=$(uname -m)

	if [[ ! -e $FW_NODE_MODULES_PATH ]]; then
		if [[ $CPU_PLATFORM == "x86_64" ]]; then
			NODE_MODULE_REPO=https://github.com/firewalla/firewalla_nodemodules.x86_64.git
			git clone $NODE_MODULE_REPO $FW_NODE_MODULES_PATH
		elif [[ $CPU_PLATFORM == "armv7l" ]]; then
			NODE_MODULE_REPO=https://github.com/firewalla/firewalla_nodemodules.git
			git clone $NODE_MODULE_REPO $FW_NODE_MODULES_PATH
			cd $FW_NODE_MODULES_PATH
			git fetch
			git checkout $branch
			git reset -q --hard $(cat $FIREWALLA_HOME/scripts/NODE_MODULES_REVISION.$CPU_PLATFORM)
			cd -
		elif [[ $CPU_PLATFORM == "aarch64" ]]; then
			NODE_MODULE_REPO=https://github.com/firewalla/fnm.node8.aarch64.git
			git clone $NODE_MODULE_REPO $FW_NODE_MODULES_PATH
			cd $FW_NODE_MODULES_PATH
			git fetch
			git checkout $branch
			git reset -q --hard $(cat $FIREWALLA_HOME/scripts/NODE_MODULES_REVISION.$CPU_PLATFORM)
			cd -
		fi
	fi

	PLATFORM=$(uname -m)

	# Skip bro installation if in docker environment, bro in apt repo will be used in Docker
	if [[ ! -f /.dockerenv ]]; then
		if [[ $PLATFORM == "armv7l" ]]; then
			echo "Installing bro..."
			if [[ ! -f $basedir/imports/bro49.tar.gz ]]; then
				cd $basedir/imports && wget https://github.com/firewalla/firewalla/releases/download/1.6/bro49.tar.gz -O bro49.tar.gz
			fi
			cd $basedir/imports && tar -zxf bro49.tar.gz && sudo cp -r -f $basedir/imports/bro /usr/local/ && rm -r -f $basedir/imports/bro || perr_and_exit "Failed to install bro."
			cp $basedir/bin/real/bit* $basedir/bin/
		# elif [[ $PLATFORM == "aarch64" ]]; then
		# 	if [[ ! -f $basedir/imports/bro-2.4.aarch64.tar.gz ]]; then
		# 		(cd $basedir/imports && wget https://github.com/firewalla/firewalla/releases/download/v1.95/bro-2.4.aarch64.tar.gz -O bro-2.4.aarch64.tar.gz)
		# 	fi
		# 	(cd $basedir/imports && tar -zxf bro-2.4.aarch64.tar.gz && sudo cp -r -f $basedir/imports/bro /usr/local/ && rm -r -f $basedir/imports/bro || perr_and_exit "Failed to install bro.")
		fi
	fi
	sudo cp $basedir/etc/sysctl.conf /etc/sysctl.conf || perr_and_exit "Failed to replace system sysctl.conf."
	sudo cp $basedir/etc/bro-cron /etc/cron.hourly/. || perr_and_exit "Failed to install root bron cronjobs."
	crontab $basedir/etc/brotab || perr_and_exit "Failed to install user bro cronjobs."

	# Enable BBR TCP congestion control
	grep "tcp_bbr" /etc/modules-load.d/modules.conf >/dev/null 2>&1
	if [[ $? -ne 0 ]]; then
		sudo bash -c 'echo "tcp_bbr" >> /etc/modules-load.d/modules.conf'
	fi

	echo "Setting up encipher..."
	sudo mkdir -p /encipher.config || perr_and_exit "Failed to create /encipher.config/"
	sudo cp $basedir/config/netbot.config /encipher.config/ || perr_and_exit "Failed top copy encipher config."
	sudo mkdir -p /firewalla && sudo chmod 777 /firewalla || perr_and_exit "Failed to create /firewalla."

	echo "Setting up brofish and firewalla services..."
	sudo cp $basedir/etc/brofish.service /etc/systemd/system/. || perr_and_exit "Failed to copy brofish.servie."
	sudo cp $basedir/etc/firewalla.service /etc/systemd/system/. || perr_and_exit "Failed to copy firewalla service."
	sudo cp $basedir/etc/fireupgrade.service /etc/systemd/system/. || perr_and_exit "Failed to copy fireupgrade service."

	# ignore systemctl part in docker enviornment, there is some bug that systemctl doesn't work in Docker
	if [[ -z ${TRAVIS+x} && ! -f /.dockerenv ]]; then

		# systemd will bring up firewalla service, which will bring up all the rest firewalla services
		sudo systemctl daemon-reload || perr_and_exit "Failed to refresh systemd services."
		sudo systemctl enable firewalla || perr_and_exit "Failed to enable firewalla service."
		sudo systemctl enable fireupgrade || perr_and_exit "Failed to enable firewalla service."
	fi
	sudo setcap cap_net_raw+eip $(eval readlink -f $(which nodejs)) || perr_and_exit "Failed setup capabilities for nodejs."

	sudo mkdir /etc/update-motd.d >/dev/null 2>&1
	sudo cp $basedir/etc/10-header /etc/update-motd.d/10-header
}

function post_installation() {
	source $FIREWALLA_HOME/scripts/utils.sh
	setup_folders
	echo 'export PATH=$PATH:/sbin' >>/home/pi/.bashrc
}

basedir=$(dirname $0)
export basedir=$(
	cd $basedir
	pwd
)
FIREWALLA_HOME=$basedir

echo "basedir is $basedir"

while getopts "tnh" opt; do
	case $opt in
	n) NO_DEPS=1 ;;
	h)
		usage
		exit 0
		;;
	?) perr_and_exit "Invalid option." ;;
	esac
done

[[ "$NO_DEPS" != 1 ]] && install_dependencies || echo "Skipping dependency installation."

setup_sys_env
install_walla
post_installation

echo "Installation successful."

exit 0
