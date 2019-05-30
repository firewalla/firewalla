#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

BINARY="${CUR_DIR}/devicemasq.$(uname -m)"

CONFIG_FILE="${CUR_DIR}/devicemasq.conf"
CONFIG_FOLDER=/home/pi/.firewalla/config/devicemasq

mkdir -p ${CONFIG_FOLDER}

$BINARY -C $CONFIG_FILE -k --clear-on-reload

trap "trap - SIGTERM && kill -- -$$" SIGINT SIGTERM EXIT
for job in `jobs -p`; do wait $job; echo "$job exited"; done