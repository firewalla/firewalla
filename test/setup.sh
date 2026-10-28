#!/bin/bash

# Usage: test/setup.sh, or "source test/setup.sh" to also put the node and npm the tests run on at the
# front of the calling shell's PATH, whether or not the test tree is already installed
if (return 0 2>/dev/null); then
  # sourced: set up in a child so its variables, exits and platform.sh stay out of this shell, and
  # take back only the PATH entries it reports on fd 3
  if test_path=$(bash "${BASH_SOURCE[0]}" 3>&1 1>&2); then
    for test_dir in $(echo "$test_path" | tr ':' ' ' | awk '{for (i = NF; i > 0; i--) print $i}'); do
      PATH=$test_dir:$(echo ":$PATH:" | sed "s#:$test_dir:#:#g; s#^:##; s#:\$##")
    done
    export PATH
    unset test_dir test_path
  else
    unset test_path
    return 1
  fi
  return 0
fi

FIREWALLA_HOME=${FIREWALLA_HOME:-$HOME/firewalla}
TEST_MODULES=/data/.node_modules.test/node_modules

# written only after npm install succeeds: a failed install still leaves most packages unpacked,
# so their presence does not mean the tree is complete
INSTALLED=$TEST_MODULES/.setup_installed

# /data is owned by root; without the tree, node_modules below becomes a dangling link and npm
# fails with EEXIST trying to create it
if [[ ! -d "$TEST_MODULES" ]]; then
  sudo mkdir -p "$TEST_MODULES" && sudo chown -R pi:pi "$(dirname "$TEST_MODULES")" || exit 1
fi

# nvm is a shell function defined by nvm.sh, so it does not exist in a non-interactive script and
# "nvm use" fails with "command not found". platform.sh picks the node the services run, so tests
# run on the same one; put it on PATH instead of switching versions with nvm.
source "$FIREWALLA_HOME/platform/platform.sh" || exit 1
NODE_BIN=$(get_node_bin_path)
NODE_BIN_DIR=$(dirname "$NODE_BIN")
NPM_BIN_DIR=$NODE_BIN_DIR

# unpacks only npm, npx and corepack of an assets tarball into $2, the part of the node install the
# upgraded Node leaves out
unpack_npm() {
  local tarball=$1 npm_dir=$2 top
  top=$(basename "$tarball" .tar.xz)
  rm -rf "$npm_dir.tmp" && mkdir -p "$npm_dir.tmp" &&
    tar -xJf "$tarball" -C "$npm_dir.tmp" --strip-components=1 \
      "$top/bin/npm" "$top/bin/npx" "$top/bin/corepack" "$top/lib/node_modules/npm" "$top/lib/node_modules/corepack" &&
    rm -rf "$npm_dir" && mv "$npm_dir.tmp" "$npm_dir" || {
      echo "failed to unpack npm from $tarball" >&2
      rm -rf "$npm_dir.tmp"
      return 1
    }
}

# the upgraded Node is installed as bin/node only (scripts/install_node.sh); its npm, npx and corepack
# are unpacked from the same assets tarball next to the test tree, leaving that install untouched
if [[ $NODE_BIN == $NODE_VERSIONS_DIR/* ]]; then
  NPM_DIR=$(dirname "$TEST_MODULES")/node-$NODE_UPGRADE_VERSION
  NPM_BIN_DIR=$NPM_DIR/bin
  if [[ ! -x "$NPM_BIN_DIR/npm" ]]; then
    tarball=$(ls "${FIREWALLA_HIDDEN:-$HOME/.firewalla}"/run/assets/node-$NODE_UPGRADE_VERSION-linux-*.tar.xz 2>/dev/null | head -n1)
    if [[ -z $tarball ]]; then
      echo "assets tarball of node $NODE_UPGRADE_VERSION not found, cannot install npm" >&2
      exit 1
    fi
    unpack_npm "$tarball" "$NPM_DIR" || exit 1
  fi
fi
if [[ ! -x "$NPM_BIN_DIR/npm" ]]; then
  echo "npm not found in $NPM_BIN_DIR" >&2
  exit 1
fi
TEST_PATH=$NPM_BIN_DIR
[[ $NODE_BIN_DIR != "$NPM_BIN_DIR" ]] && TEST_PATH=$TEST_PATH:$NODE_BIN_DIR
export PATH="$TEST_PATH:$PATH"

# PATH for the caller: on fd 3 when sourced, otherwise as a line to paste
report_path() {
  if { true >&3; } 2>/dev/null; then
    echo "$TEST_PATH" >&3
  else
    echo "PATH not changed (script was run, not sourced): source test/setup.sh, or export PATH=$TEST_PATH:\$PATH"
  fi
}

# already pointed at an installed test tree, so treat the environment as set up and do not reinstall;
# a link to a missing or half-installed tree falls through and is repaired
if [[ -L "$FIREWALLA_HOME/node_modules" && "$(readlink "$FIREWALLA_HOME/node_modules")" == "$TEST_MODULES" &&
      -e "$INSTALLED" ]]; then
  echo "node_modules already points at $TEST_MODULES, skipping setup"
  report_path
  exit 0
fi

cd "$FIREWALLA_HOME" || exit 1
# node_modules is expected to be a symlink to one of the module trees; replacing a real directory
# here would delete it, and "ln -sf" would otherwise put the link inside it
if [[ -d node_modules && ! -L node_modules ]]; then
  echo "node_modules is a real directory, refusing to replace it" >&2
  exit 1
fi
rm -f node_modules
ln -sf "$TEST_MODULES" node_modules
# npm 7 and later replace a node_modules symlink with a real directory instead of installing through
# it, so install in the tree's own directory from a copy of package.json; that also keeps
# package-lock.json out of the checkout
TEST_PREFIX=$(dirname "$TEST_MODULES")
rm -f "$INSTALLED"
cp package.json "$TEST_PREFIX/" && (cd "$TEST_PREFIX" && npm install) && touch "$INSTALLED" || exit 1
report_path
