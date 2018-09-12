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
