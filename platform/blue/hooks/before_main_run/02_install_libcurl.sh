#!/bin/bash

test -e /usr/lib/arm-linux-gnueabihf/libcurl.so.4 && exit 0

sudo cp ${FW_PLATFORM_CUR_DIR}/files/libcurl.so.4 /usr/lib/arm-linux-gnueabihf/
