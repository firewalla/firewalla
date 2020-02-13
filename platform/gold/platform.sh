MIN_FREE_MEMORY=70
SAFE_MIN_FREE_MEMORY=90
REBOOT_FREE_MEMORY=40
FIREMAIN_MAX_MEMORY=280000
FIREMON_MAX_MEMORY=240000
FIREAPI_MAX_MEMORY=200000
MAX_NUM_OF_PROCESSES=4000
MAX_NUM_OF_THREADS=20000
NODE_VERSION=10.16.3
USB_DEV=/dev/sdb1
CRONTAB_FILE=${FIREWALLA_HOME}/etc/crontab.gold


function heartbeatLED {
  echo hi >> /dev/null
}

function turnOffLED {
  echo hi >> /dev/null
}

function get_node_modules_url {
  echo "https://github.com/firewalla/fnm.node8.x86_64"
}

CURRENT_DIR=$(dirname $BASH_SOURCE)

function get_brofish_service {
  echo "${CURRENT_DIR}/files/brofish.service"
}
