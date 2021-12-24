#!/usr/bin/env bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

KERNEL_VERSION='5.4.0-88-generic'
KO_DIR="/lib/modules/$KERNEL_VERSION/kernel/net/pf_ring"
KO_PATH="$KO_DIR/pf_ring.ko"

test $(uname -r) == $KERNEL_VERSION || exit 1
sudo mkdir -p $KO_DIR
sudo cp -f ${CUR_DIR}/../../files/pf_ring-${KERNEL_VERSION}.ko $KO_PATH
sudo depmod -a
lsmod | grep -q pf_ring && sudo modprobe -r pf_ring
sudo modprobe pf_ring

exit 0