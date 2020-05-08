#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

test -e /usr/lib/aarch64-linux-gnu/libcurl.so.4 && exit 0

sudo cp ${CUR_DIR}/../../files/libcurl.so.4 /usr/lib/aarch64-linux-gnu/
