#!/bin/bash

CMD=$(basename $0)
BOOTMODE_FILE=/data/bootmode.txt
OVERLAYROOT_CONF=/tmp/overlayroot.conf
ROOT_RO_MNT=/media/root-ro
ROOT_RW_PART=/dev/mmcblk0p4


usage() {
    cat <<EOS
usage: $CMD {prep|check}
EOS
}

err() {
    echo "ERROR: $@" >&2
}

set_boot_mode() {
    m=$1
    echo -n "set boot mode to '$mode' in $BOOTMODE_FILE ... "
    echo $m >| $BOOTMODE_FILE && echo OK || { echo fail; return 1; }
}

set_overlayroot_conf() {
    _rc=0

    fstype=$1

    # remount root partition read-write
    mount -o remount,rw $ROOT_RO_MNT || _rc=1

    echo -n update overlayroot configuration to use tmpfs as upper fs ...

    test -e $OVERLAYROOT_CONF.normal || cp $OVERLAYROOT_CONF{,.normal} || _rc=1
    sed -e 's/^ *overlayroot=.*/overlayroot="tmpfs,recurse=0"/' $OVERLAYROOT_CONF >| $OVERLAYROOT_CONF.safe || _rc=1
    cp -f $OVERLAYROOT_CONF.${fstype} $OVERLAYROOT_CONF || _rc=1
    if $_rc -eq 0
    then
        echo OK
    else
        echo fail
        logger "ERROR: failed to set $OVERLAYROOT_CONF to '$fstype'"
    fi

    # remount root partition read-only
    mount -o remount,ro $ROOT_RO_MNT || _rc=1

    return $_rc
}

do_prep() {
    set_overlayroot_conf safe || return 1
    set_boot_mode $mode || return 1
}

do_check() {
    bootmode=$(cat $BOOTMODE_FILE)
    case $bootmode in
        safe)
            fsck -y $ROOT_RW_PART
            set_overlayroot_conf normal
            ;;
        reset)
            mkfs.ext4 $ROOT_RW_PART
            rm -f $BOOTMODE_FILE
            set_overlayroot_conf normal
            ;;
    esac

}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

# need root privilege
test `id -u` == `id -u root` || {
    err "Need root privilege to run this script"
    exit 1
}

rc=0
mode='safe'
op=$1

test $# -ge 1 || {
    usage
    exit 1
}

case $op in
    check) do_check ;;
    prep) do_prep ;;
esac


exit $rc
