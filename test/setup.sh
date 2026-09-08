#!/bin/bash

FIREWALLA_HOME=${FIREWALLA_HOME:-$HOME/firewalla}
TEST_MODULES=$HOME/.node_modules.test/node_modules

# already pointed at the test tree, so treat the environment as set up and do not reinstall
if [[ -L "$FIREWALLA_HOME/node_modules" && "$(readlink "$FIREWALLA_HOME/node_modules")" == "$TEST_MODULES" ]]; then
  echo "node_modules already points at $TEST_MODULES, skipping setup"
  exit 0
fi

# nvm is a shell function defined by nvm.sh, so it does not exist in a non-interactive script and
# "nvm use" fails with "command not found". platform.sh pins the node build for this platform and
# npm sits in the same directory, so put that on PATH instead of switching versions with nvm.
source "$FIREWALLA_HOME/platform/platform.sh" || exit 1
NODE_BIN_DIR=$(dirname "$(get_node_bin_path)")
if [[ ! -x "$NODE_BIN_DIR/npm" ]]; then
  echo "npm not found in $NODE_BIN_DIR" >&2
  exit 1
fi
export PATH="$NODE_BIN_DIR:$PATH"

mkdir -p "$TEST_MODULES"
cd "$FIREWALLA_HOME" || exit 1
# node_modules is expected to be a symlink to one of the module trees; replacing a real directory
# here would delete it, and "ln -sf" would otherwise put the link inside it
if [[ -d node_modules && ! -L node_modules ]]; then
  echo "node_modules is a real directory, refusing to replace it" >&2
  exit 1
fi
rm -f node_modules
ln -sf "$TEST_MODULES" node_modules
npm install
