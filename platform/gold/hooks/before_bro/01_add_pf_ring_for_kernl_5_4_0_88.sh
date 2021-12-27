#!/usr/bin/env bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

KERNEL_VERSION='5.4.0-88-generic'
KO_SRC="${CUR_DIR}/../../files/pf_ring-${KERNEL_VERSION}.ko"
KO_DIR="/lib/modules/$KERNEL_VERSION/kernel/net/pf_ring"
KO_DST="$KO_DIR/pf_ring.ko"

test $(uname -r) == $KERNEL_VERSION || exit 1
if [[ -e "$KO_DST" ]]; then
    if cmp -s $KO_SRC $KO_DST; then
        lsmod | grep -q pf_ring && exit 0
    else
        sudo cp -f $KO_SRC $KO_DST
        lsmod | grep -q pf_ring && sudo rmmod pf_ring
    fi
else
    sudo mkdir -p $KO_DIR
    sudo cp -f $KO_SRC $KO_DST
fi

sudo insmod $KO_DST

sync
exit 0
