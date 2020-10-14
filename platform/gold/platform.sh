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
CRONTAB_FILE=${FIREWALLA_HOME}/etc/crontab.gold

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
    echo "beta_8_0"
    ;;
  "master")
    echo "master"
    ;;
  *)
    echo $1
    ;;
  esac
}