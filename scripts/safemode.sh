#!/bin/bash

BOOTMODE_FILE=/data/bootmode.txt
OVERLAYROOT_CONF=/tmp/overlayroot.conf

err() {
    echo "ERROR: $@" >&2
}

update_overlayroot_conf() {
    _rc=0

    # remount root partition read-write
    mount -o remount,rw /media/root-ro

    echo -n update overlayroot configuration to use tmpfs as upper fs ...

    test -e $OVERLAYROOT_CONF.bak || cp $OVERLAYROOT_CONF{,.bak}
    sed -e 's/^ *overlayroot=.*/overlayroot="tmpfs,recurse=0"/' $OVERLAYROOT_CONF >| $OVERLAYROOT_CONF.safe || _rc=1
    cp -f $OVERLAYROOT_CONF{.safe,} || _rc=1

    test $_rc -eq 0 && echo OK || {
        echo fail
        logger ERROR: failed to update $OVERLAYROOT_CONF with tmpfs
    }

    # remount root partition read-only
    mount -o remount,ro /media/root-ro

    return $_rc
}

set_boot_mode() {
    m=$1
    echo -n "set boot mode to '$mode' in $BOOTMODE_FILE ... "
    echo $m >| $BOOTMODE_FILE && echo OK || { echo fail; return 1; }
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

rc=0
mode='safe'

while getopts ":r" opt
do
    case $opt in
        r) mode='reset' ;;
    esac
done

# need root privilege
test `id -u` == `id -u root` || {
    err "Need root privilege to run this script"
    exit 1
}

update_overlayroot_conf || rc=1

set_boot_mode $mode || rc=1

exit $rc
