#!/usr/bin/env bash
#

# $ sudo ./test_wan.sh vpn_d7 curl -s -m 5 -o /dev/null -I -w '%{http_code}' https://1.1.1.1
# 200
# $ curl -s -m 5 -o /dev/null -I -w '%{http_code}' https://1.1.1.1
# 000

# WAN_NAME can be wan, vpn, virtual wan group uuid 10-char prefix
# Example: ./test_wan.sh 4a332667-3909 curl https://1.0.0.1
#
: "${FIREWALLA_HOME:=/home/pi/firewalla}"

source "${FIREWALLA_HOME}/platform/platform.sh"

# exit if not supported
test -z $CGROUP_SOCK_MARK && exit 1

WAN_NAME=$1
shift
CMD="$@"

MARK=$(ip rule list | grep fwmark | grep -w vpn_client_${WAN_NAME} | awk '{print $5}' | grep -vw "iif lo" | awk -F/ '{print $1}')
if test -z "$MARK"; then
    MARK=$(ip rule list | grep fwmark | grep -w vwg_${WAN_NAME} | awk '{print $5}' | grep -vw "iif lo" | awk -F/ '{print $1}')
fi
if test -z "$MARK"; then
    MARK=$(ip rule list | grep fwmark | grep -w "lookup ${WAN_NAME}_default" | grep -vw "iif lo" | awk '{print $5}' | awk -F/ '{print $1}')
fi

test -z "$MARK" && echo invalid WAN $WAN_NAME && exit 2

CGROUP_MNT=/sys/fs/cgroup/cgroup-test-wan-$WAN_NAME-$RANDOM

cleanup() {
    ${CGROUP_SOCK_MARK} -d ${CGROUP_MNT}
    rmdir ${CGROUP_MNT}
}

trap 'cleanup; exit 1' INT

mkdir $CGROUP_MNT || exit 3

${CGROUP_SOCK_MARK} -m ${MARK} ${CGROUP_MNT} || exit 4

# run the command
bash -c "echo \$\$ > $CGROUP_MNT/cgroup.procs; $CMD"

RET=$?

cleanup

exit $RET
