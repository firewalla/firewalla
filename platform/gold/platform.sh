MIN_FREE_MEMORY=280
SAFE_MIN_FREE_MEMORY=360
REBOOT_FREE_MEMORY=160
FIREMAIN_MAX_MEMORY=560000
FIREMON_MAX_MEMORY=480000
FIREAPI_MAX_MEMORY=400000
MAX_NUM_OF_PROCESSES=6000
MAX_NUM_OF_THREADS=40000
NODE_VERSION=10.16.3
USB_DEV=/dev/sdb1
MANAGED_BY_FIREBOOT=yes
CRONTAB_FILE=${FIREWALLA_HOME}/etc/crontab.gold
REAL_PLATFORM='real.x86_64'
FW_PROBABILITY="0.99"
FW_SCHEDULE_BRO=false
IFB_SUPPORTED=yes

function get_openssl_cnf_file {
  echo '/etc/openvpn/easy-rsa/openssl.cnf'
}

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

function get_sysctl_conf_path {
  echo "${CURRENT_DIR}/files/sysctl.conf"
}

function map_target_branch {
  case "$1" in
  "release_6_0")
    echo "release_7_0"
    ;;
  "beta_6_0")
    echo "beta_8_0"
    ;;
  "beta_7_0")
    echo "beta_9_0"
    ;;
  "beta_8_0")
    echo "beta_9_0"
    ;;
  "master")
    echo "master"
    ;;
  *)
    echo $1
    ;;
  esac
}

function run_horse_light {
  flash_interval=${1:-2}
  pause_interval=${2:-1}
  sudo pkill -9 ethtool
  for ((i=3;i>=0;i--))
  do
    sudo timeout $flash_interval ethtool -p eth${i}
    sleep $pause_interval
  done
}

function fw_blink {
  sudo pkill -9 ethtool
  sudo timeout 3600s ethtool -p $1 &
}

function fw_unblink {
  sudo pkill -9 ethtool
}