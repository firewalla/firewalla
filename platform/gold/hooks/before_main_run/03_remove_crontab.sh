#!/bin/bash

sudo bash -c "test -e /media/root-ro/var/spool/cron/crontabs/pi && overlayroot-chroot /bin/rm /var/spool/cron/crontabs/pi &>/dev/null"