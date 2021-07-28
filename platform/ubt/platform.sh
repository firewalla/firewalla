MIN_FREE_MEMORY=70
SAFE_MIN_FREE_MEMORY=90
REBOOT_FREE_MEMORY=40
FIREMAIN_MAX_MEMORY=280000
FIREMON_MAX_MEMORY=240000
FIREAPI_MAX_MEMORY=200000
MAX_NUM_OF_PROCESSES=4000
MAX_NUM_OF_THREADS=20000
MANAGED_BY_FIREBOOT=no
CRONTAB_FILE=${FIREWALLA_HOME}/etc/crontab
REAL_PLATFORM='real.navy'
FW_PROBABILITY="0.98"
FW_SCHEDULE_BRO=false
FW_ZEEK_CPU_THRESHOLD=98
FW_ZEEK_RSS_THRESHOLD=380000

function get_openssl_cnf_file {
  echo '/etc/openvpn/easy-rsa/openssl-1.0.0.cnf'
}

function heartbeatLED {
  sudo sh -c 'echo heartbeat > /sys/devices/platform/gpio-leds/leds/status_led/trigger'
}

function turnOffLED {
  sudo sh -c 'echo none > /sys/devices/platform/gpio-leds/leds/status_led/trigger'
  sudo sh -c 'echo 0 > /sys/devices/platform/gpio-leds/leds/status_led/brightness'
}

function get_node_modules_url {
  echo "https://github.com/firewalla/fnm.node12.aarch64"
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
  case "$1" in
  "release_6_0")
    echo "release_8_0"
    ;;
  "beta_6_0")
    echo "beta_6_0"
    ;;
  *)
    echo $1
    ;;
  esac
}

function hook_server_route_up {
  # adjust rps_cpus for better performance
  sudo bash -c "echo 7 > /sys/class/net/tun_fwvpn/queues/rx-0/rps_cpus"
}

function hook_after_vpn_confgen {
  OVPN_CFG="$1"
  fgrep -q fast-io $OVPN_CFG || {

    sudo bash -c "cat >> $OVPN_CFG" <<EOS
fast-io
sndbuf 0
rcvbuf 0
EOS
  }

}
