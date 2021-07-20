MIN_FREE_MEMORY=70
SAFE_MIN_FREE_MEMORY=90
REBOOT_FREE_MEMORY=40
FIREMAIN_MAX_MEMORY=280000
FIREMON_MAX_MEMORY=240000
FIREAPI_MAX_MEMORY=200000
MAX_NUM_OF_PROCESSES=4000
MAX_NUM_OF_THREADS=20000
MANAGED_BY_FIREBOOT=yes
CRONTAB_FILE=${FIREWALLA_HOME}/etc/crontab.gold
REAL_PLATFORM='real.purple'
FW_PROBABILITY="0.99"
FW_QOS_PROBABILITY="0.999"
FW_SCHEDULE_BRO=false
STATUS_LED_PATH='/sys/devices/platform/leds/leds/blue'
IFB_SUPPORTED=yes
XT_TLS_SUPPORTED=yes
MANAGED_BY_FIREROUTER=yes
RAMFS_ROOT_PARTITION=yes

function get_openssl_cnf_file {
  echo '/etc/openvpn/easy-rsa/openssl-1.0.0.cnf'
}

function heartbeatLED {
  sudo sh -c "echo heartbeat > $STATUS_LED_PATH/trigger"
}

function turnOffLED {
  sudo sh -c "echo none > $STATUS_LED_PATH/trigger"
  sudo sh -c "echo 0 > $STATUS_LED_PATH/brightness"
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

function get_node_bin_path {
  echo "/home/pi/.nvm/versions/node/v12.18.3/bin/node"
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

function fw_blink {
  sudo pkill -9 ethtool
  sudo timeout 3600s ethtool -p $1 &
}

function fw_unblink {
  sudo pkill -9 ethtool
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

function installTLSModule {
  uid=$(id -u pi)
  gid=$(id -g pi)
  if ! lsmod | grep -wq "xt_tls"; then
    sudo insmod ${FW_PLATFORM_CUR_DIR}/files/xt_tls.ko max_host_sets=1024 hostset_uid=${uid} hostset_gid=${gid}
    sudo install -D -v -m 644 ${FW_PLATFORM_CUR_DIR}/files/libxt_tls.so /usr/lib/aarch64-linux-gnu/xtables
  fi
}

function led() {
  color=$1
  state=$2
  case $color in
    red)  c=red  ;;
    blue) c=blue ;;
    *) return 1 ;;
  esac
  case $state in
    blink) s='timer' ;;
       on) s='default-on' ;;
      off) s='none' ;;
    *) return 1 ;;
  esac
  sudo bash -c "echo $s > /sys/devices/platform/leds/leds/$c/trigger"
}

function indicate_system_status() {
  status=$1
  case $status in
    booting_up)
      led blue blink
      ;;
    ready_for_pairing)
      led blue on
      ;;
    system_error)
      led red on
      ;;
    network_down)
      led red blink
      ;;
    reset_to_normal)
      led red off
      led blue off
      ;;
  esac
  return 0
}
