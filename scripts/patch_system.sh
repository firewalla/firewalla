#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

cd /data/patch/deb/
[[ $? == 0 ]] && for FILE in $(ls); do
  # file name should be the package name without extension
  VERSION=$(dpkg -I $FILE | grep Version: | cut -d':' -f2-)
  INSTALLED=$(apt-cache policy $FILE | grep Installed: | cut -d':' -f2-)
  if [[ "$VERSION" == "$INSTALLED" ]]; then
    echo "$FILE has $INSTALLED installed, skip"
    continue
  fi

  # this does NOT persist after reboot
  sudo dpkg -i $FILE
done
