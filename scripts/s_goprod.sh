#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

cd $FIREWALLA_HOME
scripts/switch_branch.sh release_6_0 && NO_FIREKICK_RESTART=1 scripts/fireupgrade.sh soft
