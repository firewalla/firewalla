#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

CONFIG_FILE="$HOME/.firewalla/run/dnscrypt.toml"

# The fireupgrade asset (assets.lst) when there is one, otherwise the build in
# the repo. update_assets.sh restarts the service once a new asset is in place,
# so a box that started on the repo build moves to the asset right away.
BINARY="$HOME/.firewalla/run/assets/dnscrypt"
if [[ ! -x $BINARY ]]; then
  BINARY="$DIR/dnscrypt.$(uname -m)"
fi

exec $BINARY -config $CONFIG_FILE
