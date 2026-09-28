#!/bin/bash -

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh
[ -s $FIREWALLA_HOME/scripts/upgrade_verify.sh ] && source $FIREWALLA_HOME/scripts/upgrade_verify.sh

MGIT=$(PATH=/home/pi/scripts:$FIREWALLA_HOME/scripts; /usr/bin/which mgit||echo git)
branch=$(cd $FIREWALLA_HOME > /dev/null; git rev-parse --abbrev-ref HEAD)

function update_firewalla {
    ( cd $FIREWALLA_HOME
    $MGIT fetch origin $branch
    $MGIT reset --hard FETCH_HEAD
    )
}


