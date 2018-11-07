MIN_FREE_MEMORY=35
SAFE_MIN_FREE_MEMORY=45
REBOOT_FREE_MEMORY=20
FIREMAIN_MAX_MEMORY=140000
FIREMON_MAX_MEMORY=120000
FIREAPI_MAX_MEMORY=100000
MAX_NUM_OF_PROCESSES=2000
MAX_NUM_OF_THREADS=10000

function heartbeatLED {
  sudo sh -c 'echo heartbeat > /sys/class/leds/nanopi:blue:status/trigger'
  sudo sh -c 'echo heartbeat > /sys/class/leds/nanopi:green:pwr/trigger'
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