#!/usr/bin/env bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

test "$(type -t fire-temp-check)" == "function" && fire-temp-check
