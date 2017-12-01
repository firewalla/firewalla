#!/bin/bash

rc=0

: ${FIREWALLA_HOME:=/home/pi/firewalla}

node8_exists() {
    node_version=$(${FIREWALLA_HOME}/bin/node -v 2>/dev/null)
    test ${node_version:0:2} == 'v8'
    return $?
}

node8_exists && {
    logger "Node v8 already exists"
    exit 0
}

logger "Start install Node8 with NVM"

export NVM_DIR="/home/pi/.nvm"
export NVM_VERSION=0.33.6
export NODE_VERSION="8.7.0"

bash ${FIREWALLA_HOME}/scripts/prep/nvm_install

source $NVM_DIR/nvm.sh

nvm install $NODE_VERSION || rc=1

node8_exists || rc=1

exit $rc
