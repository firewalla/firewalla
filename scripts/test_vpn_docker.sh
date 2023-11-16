#!/usr/bin/env bash

: "${FIREWALLA_HOME:=/home/pi/firewalla}"

source "${FIREWALLA_HOME}/platform/platform.sh"

# exit if not supported
test -z $CGROUP_SOCK_MARK && exit 1

VPN_NAME=$1
MARK=$2
CMD="$3"

CGROUP_MNT=/tmp/cgroup-test-vpn-docker-$VPN_NAME
mkdir -p ${CGROUP_MNT}
mount -t cgroup2 none ${CGROUP_MNT}

${CGROUP_SOCK_MARK} -m ${MARK} ${CGROUP_MNT}

# run the command
bash -c "echo \$\$ > $CGROUP_MNT/cgroup.procs; $CMD"

${CGROUP_SOCK_MARK} -d ${CGROUP_MNT}
