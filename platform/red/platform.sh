MIN_FREE_MEMORY=35
SAFE_MIN_FREE_MEMORY=45
REBOOT_FREE_MEMORY=20
FIREMAIN_MAX_MEMORY=140000
FIREMON_MAX_MEMORY=120000
FIREAPI_MAX_MEMORY=100000
MAX_NUM_OF_PROCESSES=2000
MAX_NUM_OF_THREADS=10000
CRONTAB_FILE=${FIREWALLA_HOME}/etc/crontab
REAL_PLATFORM='real.armv7l'
#TCP_BBR=yes
NEED_FIREHB=false
FW_ZEEK_RSS_THRESHOLD=100000

function get_openssl_cnf_file {
  echo '/etc/openvpn/easy-rsa/openssl-1.0.0.cnf'
}

function heartbeatLED {
  sudo sh -c 'echo heartbeat > /sys/class/leds/nanopi:blue:status/trigger'
  sudo sh -c 'echo heartbeat > /sys/class/leds/nanopi:green:pwr/trigger'
}

function turnOffLED {
  sudo sh -c 'echo none > /sys/class/leds/nanopi:blue:status/trigger'
  sudo sh -c 'echo 0 > /sys/class/leds/nanopi:blue:status/brightness'
  sudo sh -c 'echo none > /sys/class/leds/nanopi:green:pwr/trigger'
  sudo sh -c 'echo 0 > /sys/class/leds/nanopi:green:pwr/brightness'
}

function get_zeek_log_dir {
  echo "/blog/"
}

function get_node_modules_url {
  local NODE_VERSION=$(${FIREWALLA_HOME}/bin/node -v 2>/dev/null)

  if [[ ${NODE_VERSION:0:2} == 'v8' ]]; then
        echo "https://github.com/firewalla/fnm.node8.armv7l"
  elif [[ ${NODE_VERSION:0:2} == 'v4' ]]; then
        echo "https://github.com/firewalla/firewalla_nodemodules.git"
  else
    echo "https://github.com/firewalla/fnm.node8.armv7l"
  fi
}


CURRENT_DIR=$(dirname $BASH_SOURCE)

function get_brofish_service {
  echo "${CURRENT_DIR}/files/brofish.service"
}

function get_openvpn_service {
  echo "${CURRENT_DIR}/files/openvpn@.service"
}

function get_sysctl_conf_path {
  echo "${CURRENT_DIR}/files/sysctl.conf"
}

function map_target_branch {
  echo "$1"
}