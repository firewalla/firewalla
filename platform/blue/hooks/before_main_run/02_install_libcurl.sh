#!/bin/bash

test -e /usr/lib/aarch64-linux-gnu/libcurl.so.4 && exit 0

sudo cp ${FW_PLATFORM_CUR_DIR}/files/libcurl.so.4 /usr/lib/aarch64-linux-gnu/
