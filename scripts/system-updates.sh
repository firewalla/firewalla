#!/bin/bash

: ${FIREWALLA_HOME:="$HOME/firewalla"}
CMD=$(basename $0)
source ${FIREWALLA_HOME}/platform/platform.sh

UPGRADE_PKGS='
    apport
    bind9-host
    binutils
    binutils-common
    binutils-x86-64-linux-gnu
    dnsutils
    intel-microcode
    python3-apport
    libbind9-160
    libbsd0
    libc6
    libc6-dev
    libdns-export1100
    libdns1100
    libirs160
    libisc-export169
    libisc169
    libisccc160
    libisccfg160
    liblwres160
    liblz4-1
    libnss3
    libnss3-tools
    libpython2.7
    libpython2.7-dev
    libpython2.7-minimal
    libpython2.7-stdlib
    libpython3.6
    libpython3.6-minimal
    libpython3.6-stdlib
    libssl-dev
    libssl1.0.0
    libssl1.1
    libunbound2
    libx11-6
    libx11-data
    openssl
    ppp
    python2.7
    python2.7-dev
    python2.7-minimal
    python3.6
    python3.6-minimal
    python3-twisted
    python3-twisted-bin
    rsync
    screen
    squashfs-tools
    sudo
    tcpdump
    vim
    vim-common
    vim-runtime
    vim-tiny
'

LOG_FILE=$HOME/logs/${CMD/.sh/.log}
DATE_FORMAT='[%Y-%m-%d %H:%M:%S]'
LOG_QUIET=0
LOG_ERROR=1
LOG_WARN=2
LOG_INFO=3
LOG_DEBUG=4

: ${LOGLEVEL:=$LOG_INFO}

mylog() {
    echo "$(date +"$DATE_FORMAT")$@"
}
mylogn() {
    echo -n "$(date +"$DATE_FORMAT")$@"
}

logdebug() {
    test $LOGLEVEL -ge $LOG_DEBUG || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[DEBUG] $@" >&2
    else
        mylog "[DEBUG] $@" >&2
    fi
}

loginfo() {
    test $LOGLEVEL -ge $LOG_INFO || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[INFO] $@"
    else
        mylog "[INFO] $@"
    fi
}

logwarn() {
    test $LOGLEVEL -ge $LOG_WARN || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[WARN] $@" >&2
    else
        mylog "[WARN] $@" >&2
    fi
}

logerror() {
    test $LOGLEVEL -ge $LOG_ERROR || return 0
    if [[ $1 == '-n' ]]; then
        shift
        mylogn "[ERROR] $@" >&2
    else
        mylog "[ERROR] $@" >&2
    fi
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

rc=0
list_ok=''
list_failed=''
touch $LOG_FILE
SIZE_NEW=500M
SIZE_OLD=200M

test $FIREWALLA_PLATFORM == 'gold' || {
  logerror "ONLY run this script on Gold"
  exit 1
}

loginfo "Lock running script"
LOCK_FILE=/var/lock/${CMD/.sh/.lock}
exec {lock_fd}> $LOCK_FILE
flock -x -n $lock_fd || {
        logerror "Another instance of $CMD is already running, abort"
    exit 1
}
echo $$ > $LOCK_FILE

loginfo "Remount root-rw to size of $SIZE_NEW"
sudo mount -o remount,size=$SIZE_NEW /media/root-rw

for p in $UPGRADE_PKGS
do
    loginfo -n "Upgrading $p ... "
    if $FIREWALLA_HOME/scripts/apt-get.sh -nr install -y $p >> $LOG_FILE 2>&1
    then
        echo OK
        list_ok="$list_ok $p"
    else
        echo fail
        list_failed="$list_failed $p"
        rc=1
    fi
done

if [[ $rc -eq 0 ]]
then
    loginfo "All system updates installed successfully."
else
    logerror "Some system updates FAILED to install."
    logerror "  OK    : $list_ok"
    logerror "  failed: $list_failed"
fi

loginfo "Remount root-rw to size of $SIZE_NEW"
sudo mount -o remount,size=$SIZE_OLD /media/root-rw

exit $rc
