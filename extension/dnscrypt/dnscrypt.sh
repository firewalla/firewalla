#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

CONFIG_FILE="$HOME/.firewalla/run/dnscrypt.toml"

ARCH=$(uname -m)
if [[ $ARCH == armv7l ]]; then
  BINARY="$DIR/dnscrypt.$ARCH"
else
  # x86_64 and aarch64 builds are fireupgrade assets, listed in each platform's assets.lst
  BINARY="$HOME/.firewalla/run/assets/dnscrypt"
fi

exec $BINARY -config $CONFIG_FILE
