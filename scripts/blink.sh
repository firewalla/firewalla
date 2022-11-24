#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

type fw_unblink &> /dev/null || exit 0
type fw_blink &> /dev/null || exit 0

test "x$1" == "x" && fw_unblink
test "x$1" != "x" && fw_blink $1