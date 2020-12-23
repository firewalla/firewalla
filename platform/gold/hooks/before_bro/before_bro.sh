#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

if [[ -e /log/blog ]]; then
  sudo ln -sfT /log/blog/current /blog/current
fi

sync
