#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

test -e /usr/lib/aarch64-linux-gnu/libcrypto.so.1.0.0 && exit 0

sudo cp ${CUR_DIR}/../../files/libcrypto.so.1.0.0 /usr/lib/aarch64-linux-gnu/
