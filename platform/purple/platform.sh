MIN_FREE_MEMORY=70
SAFE_MIN_FREE_MEMORY=90
REBOOT_FREE_MEMORY=40
FIREMAIN_MAX_MEMORY=512000
FIREMON_MAX_MEMORY=360000
FIREAPI_MAX_MEMORY=360000
MAX_NUM_OF_PROCESSES=4000
MAX_NUM_OF_THREADS=20000
MANAGED_BY_FIREBOOT=yes
CRONTAB_FILE=${FIREWALLA_HOME}/etc/crontab.gold
REAL_PLATFORM='real.purple'
FW_PROBABILITY="0.99"
FW_QOS_PROBABILITY="0.999"
ALOG_SUPPORTED=yes
FW_SCHEDULE_BRO=false
STATUS_LED_PATH='/sys/devices/platform/leds/leds/blue'
IFB_SUPPORTED=yes
XT_TLS_SUPPORTED=yes
MANAGED_BY_FIREROUTER=yes
RAMFS_ROOT_PARTITION=yes
MAX_OLD_SPACE_SIZE=384

function get_openssl_cnf_file {
  echo '/etc/openvpn/easy-rsa/openssl.cnf'
}

function get_node_modules_url {
  echo "https://github.com/firewalla/fnm.node12.aarch64"
}

CURRENT_DIR=$(dirname $BASH_SOURCE)
FIRESTATUS_CONFIG=${CURRENT_DIR}/files/firestatus.yml
FIRESTATUS_BIN=${CURRENT_DIR}/files/firestatus
NEED_FIRESTATUS=true

function get_brofish_service {
  echo "${CURRENT_DIR}/files/brofish.service"
}

function get_openvpn_service {
  echo "${CURRENT_DIR}/files/openvpn@.service"
}

function get_suricata_service {
  echo "${CURRENT_DIR}/files/suricata.service"
}

function get_sysctl_conf_path {
  echo "${CURRENT_DIR}/files/sysctl.conf"
}

function get_dynamic_assets_list {
  echo "${CURRENT_DIR}/files/assets.lst"
}

function get_node_bin_path {
  echo "/home/pi/.nvm/versions/node/v12.18.3/bin/node"
}

function map_target_branch {
  case "$1" in
  "release_6_0")
    echo "release_9_0"
    ;;
  "beta_6_0")
    echo "beta_12_0"
    ;;
  "beta_7_0")
    echo "beta_13_0"
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

function installSchCakeModule {
  if ! modinfo sch_cake > /dev/null || [[ $(sha256sum /lib/modules/$(uname -r)/kernel/net/sched/sch_cake.ko | awk '{print $1}') != $(sha256sum ${FW_PLATFORM_CUR_DIR}/files/sch_cake.ko | awk '{print $1}') ]]; then
    sudo cp ${FW_PLATFORM_CUR_DIR}/files/sch_cake.ko /lib/modules/$(uname -r)/kernel/net/sched/
    sudo depmod -a
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

function led_boot_state() {
  bs=$1
  case $bs in
    booting)
      led blue blink
      ;;
    ready4pairing)
      led blue on
      ;;
    paired)
      led blue off
      ;;
  esac
  return 0
}

function restart_bluetooth_service() {
  sudo systemctl restart rtk-hciuart.service
}
