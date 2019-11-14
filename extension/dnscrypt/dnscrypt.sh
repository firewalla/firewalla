#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

CONFIG_FILE="$HOME/.firewalla/run/dnscrypt.toml"

BINARY="$DIR/dnscrypt.${uname -m}"

$BINARY -config $CONFIG_FILE