#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
CMD=$(basename $0)

mylog() {
  tee >(logger -t $CMD "$@")
}

loginfo() {
  echo "[INFO] $@" | mylog
}

logerror() {
  echo "[ERROR] $@" >&2 | mylog
}

MNT_RO=/media/root-ro
CFG_FILE=${MNT_RO}/etc/overlayroot.local.conf
fgrep -q 'LABEL=root-rw' $CFG_FILE || {
  loginfo "LABEL=root-rw NOT found in $CFG_FILE"
  exit 0
}

root_rw_dev_path=$(blkid -L root-rw)
test -n "$root_rw_dev_path" || {
  logerror "Failed to get root-rw device path"
  exit 1
}

mounted_opt=$(findmnt -no OPTIONS $MNT_RO | grep -ow 'r[ow]')
loginfo "Partition root-ro was mounted $mounted_opt"

test $mounted_opt == 'ro' && sudo mount -o remount,rw $MNT_RO
loginfo "Replacing root-rw device in $CFG_FILE with $root_rw_dev_path"
sudo sed -i.bak -e "s|LABEL=root-rw|${root_rw_dev_path}|" $CFG_FILE
test $mounted_opt == 'ro' && sudo mount -o remount,ro $MNT_RO

loginfo "Show diff in $CFG_FILE"
diff -u $CFG_FILE{.bak,} | mylog

loginfo "Script $CMD finished successfully"
exit 0
