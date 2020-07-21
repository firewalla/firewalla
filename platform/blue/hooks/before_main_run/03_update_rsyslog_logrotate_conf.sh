#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

sudo cp ${CUR_DIR}/../../files/rsyslog.logrotate /etc/logrotate.d/rsyslog

if [[ -f /etc/cron.daily/logrotate ]]; then
  sudo mv /etc/cron.daily/logrotate /etc/cron.hourly/
fi