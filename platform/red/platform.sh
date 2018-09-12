MIN_FREE_MEMORY=35

function heartbeatLED {
  sudo sh -c 'echo heartbeat > /sys/class/leds/nanopi:blue:status/trigger'
  sudo sh -c 'echo heartbeat > /sys/class/leds/nanopi:green:pwr/trigger'
}
