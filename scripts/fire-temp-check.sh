#!/usr/bin/env bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

function fire-temp-check {
    return 0
}

function fire-temp-uncheck {
    return 0
}

source ${FIREWALLA_HOME}/platform/platform.sh

FLAG=$(redis-cli get sys:bone:info | jq .cloudConfig.fireTempCheck)

if [[ "x$FLAG" == "x1" ]]; then
    fire-temp-check
fi

if [[ "x$FLAG" == "x2" ]]; then
    fire-temp-uncheck
fi
