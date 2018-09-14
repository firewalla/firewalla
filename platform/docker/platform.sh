MIN_FREE_MEMORY=70
SAFE_MIN_FREE_MEMORY=90
REBOOT_FREE_MEMORY=40
FIREMAIN_MAX_MEMORY=280000
FIREMON_MAX_MEMORY=240000
FIREAPI_MAX_MEMORY=200000
MAX_NUM_OF_PROCESSES=4000
MAX_NUM_OF_THREADS=20000

function heartbeatLED {
  echo hi > /dev/null; # do nothing
}

function get_node_modules_url {
  echo "https://github.com/firewalla/fnm.node8.x86_64"
}