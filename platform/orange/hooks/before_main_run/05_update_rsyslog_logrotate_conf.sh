#!/bin/bash

if [[ -f /etc/logrotate.d/rsyslog ]]; then
  find /etc/logrotate.d/rsyslog -not -perm 644 -exec sudo chmod 644 {} \;
fi
