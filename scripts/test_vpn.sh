#!/usr/bin/env bash
#

# $ sudo ./test_vpn.sh vpn_d7 "curl -s -m 5 -o /dev/null -I -w '%{http_code}' https://1.1.1.1"
# 200
# $ curl -s -m 5 -o /dev/null -I -w '%{http_code}' https://1.1.1.1
# 000

: "${FIREWALLA_HOME:=/home/pi/firewalla}"

source "${FIREWALLA_HOME}/platform/platform.sh"

# exit if not supported
test -z $CGROUP_SOCK_MARK && exit 1

VPN_NAME=$1
CMD="$2"

MARK=$(ip rule list | grep -w vpn_client_${VPN_NAME} | awk '{print $5}' | awk -F/ '{print $1}')

CGROUP_MNT=/tmp/cgroup-test-vpn-$VPN_NAME

cleanup() {
    umount ${CGROUP_MNT}
}

trap 'cleanup; exit 1' INT

mkdir -p ${CGROUP_MNT}
mount -t cgroup2 none ${CGROUP_MNT}

${CGROUP_SOCK_MARK} -m ${MARK} ${CGROUP_MNT}

# run the command
bash -c "echo \$\$ > $CGROUP_MNT/cgroup.procs; $CMD"

RET=$?

${CGROUP_SOCK_MARK} -d ${CGROUP_MNT}

cleanup

exit $RET
