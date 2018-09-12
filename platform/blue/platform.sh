MIN_FREE_MEMORY=70

function heartbeatLED {
  sudo sh -c 'echo none > /sys/devices/platform/leds/leds/nanopi:green:status/trigger'
  sudo sh -c 'echo heartbeat > /sys/devices/platform/leds/leds/nanopi:red:pwr/trigger'
}