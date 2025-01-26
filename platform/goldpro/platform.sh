MIN_FREE_MEMORY=280
SAFE_MIN_FREE_MEMORY=360
REBOOT_FREE_MEMORY=160
FIREMAIN_MAX_MEMORY=684000
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
FW_QOS_PROBABILITY="0.999"
ALOG_SUPPORTED=yes
FW_SCHEDULE_BRO=false
IFB_SUPPORTED=yes
XT_TLS_SUPPORTED=yes
MANAGED_BY_FIREROUTER=yes
REDIS_MAXMEMORY=600mb
RAMFS_ROOT_PARTITION=yes
FW_ZEEK_RSS_THRESHOLD=800000
MAX_OLD_SPACE_SIZE=512
HAVE_FWAPC=yes
WAN_INPUT_DROP_RATE_LIMIT=16

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
FIRESTATUS_CONFIG=${CURRENT_DIR}/files/firestatus.yml
FIRESTATUS_BIN=${CURRENT_DIR}/files/firestatus
RUN_FIRESTATUS_AS_ROOT=yes
FIRESTATUS_EXTRA_ARGS="-platform goldpro"
NEED_FIRESTATUS=true
CGROUP_SOCK_MARK=${CURRENT_DIR}/files/cgroup_sock_mark

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
  echo "/home/pi/.nvm/versions/node/v12.14.0/bin/node"
}

function map_target_branch {
  case "$1" in
  "release_6_0")
    echo "release_12_0"
    ;;
  "beta_6_0")
    echo "beta_18_0"
    ;;
  "beta_7_0")
    echo "beta_19_0"
    ;;
  "master")
    echo "master"
    ;;
  *)
    echo $1
    ;;
  esac
}

function beep {
  flock /dev/shm/gpio.lock -c 'echo "92 1" | sudo tee -a /sys/class/misc/gpio-nuvoton/select'
  flock /dev/shm/gpio.lock -c 'echo "92 0" | sudo tee -a /sys/class/misc/gpio-nuvoton/direction'
  COUNT=$1
  while [[ $COUNT -gt 0 ]]; do
    flock /dev/shm/gpio.lock -c 'echo "92 1" | sudo tee -a /sys/class/misc/gpio-nuvoton/output'
    sleep 0.16
    flock /dev/shm/gpio.lock -c 'echo "92 0" | sudo tee -a /sys/class/misc/gpio-nuvoton/output'
    sleep 0.12
    ((COUNT=COUNT-1))
  done
}
