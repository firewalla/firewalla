#!/bin/bash

CMD=$(basename $0)
BOOTMODE_FILE=/data/bootmode.txt
ROOT_RO_MNT=/media/root-ro
ROOT_RO_PART=/dev/mmcblk0p1
ROOT_RW_PART=/dev/mmcblk0p4
OVERLAYROOT_CONF=$ROOT_RO_MNT/etc/overlayroot.conf


usage() {
    cat <<EOS
usage: $CMD {check|safe|reset}
EOS
}

err() {
    echo "ERROR: $@" >&2
}

set_boot_mode() {
    m=$1
    echo -n "set boot mode to '$m' in $BOOTMODE_FILE ... "
    echo $m >| $BOOTMODE_FILE && echo OK || { echo fail; return 1; }
}

# set overlayroot.conf with a partition(normal mode of overlay) or "tmpfs"(safe mode)
set_overlayroot() {
    _rc=0

    fstype=$1

    # remount root partition read-write
    mount -o remount,rw $ROOT_RO_MNT || _rc=1

    echo -n update overlayroot configuration to use tmpfs as upper fs ...

    sed -e "s/^ *overlayroot=.*/overlayroot=\"${fstype},recurse=0\"/" $OVERLAYROOT_CONF >| $OVERLAYROOT_CONF.new \
        && chmod 0640 $OVERLAYROOT_CONF.new \
        && mv -f $OVERLAYROOT_CONF.new $OVERLAYROOT_CONF || _rc=1
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
    set_overlayroot tmpfs || return 1
    set_boot_mode $1 || return 1
}

do_check() {
    bootmode=$(cat $BOOTMODE_FILE)
    case $bootmode in
        safe)
            fsck.ext4 -p -C0 $ROOT_RO_PART
            set_overlayroot $ROOT_RW_PART
            ;;
        reset)
            mkfs.ext4 $ROOT_RW_PART
            rm -f $BOOTMODE_FILE
            set_overlayroot $ROOT_RW_PART
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
    safe) do_prep safe ;;
    reset) do_prep reset ;;
esac


exit $rc
