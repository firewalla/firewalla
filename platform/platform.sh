#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

UNAME=$(uname -m)

case "$UNAME" in
"x86_64")
  source $DIR/docker/platform.sh
  ;;
"aarch64")
  source $DIR/blue/platform.sh
  ;;
"armv7l")
  source $DIR/red/platform.sh
  ;;
*)
  ;;
esac