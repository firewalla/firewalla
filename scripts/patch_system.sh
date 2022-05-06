#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

date
cd /data/patch/deb/
[[ $? == 0 ]] && for FILE in $(ls); do
  # file name should be the package name without extension
  PKG_NAME=$(echo "$FILE" | cut -d'-' -f2-)
  VERSION=$(dpkg -I $FILE | grep Version: | cut -d':' -f2-)
  INSTALLED=$(apt-cache policy $PKG_NAME | grep Installed: | cut -d':' -f2-)
  if [[ "$VERSION" == "$INSTALLED" ]]; then
    echo "$PKG_NAME has$INSTALLED installed, skip"
    continue
  fi

  # this does NOT persist after reboot
  # does presists for navy
  sudo dpkg -i $FILE
done
echo ""
