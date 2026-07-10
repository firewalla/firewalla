#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

sudo cp ${CUR_DIR}/../../files/wtmp.logrotate /etc/logrotate.d/wtmp
sudo cp ${CUR_DIR}/../../files/btmp.logrotate /etc/logrotate.d/btmp