#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

sudo cp ${CUR_DIR}/../../files/logrotate.conf /etc/logrotate.conf