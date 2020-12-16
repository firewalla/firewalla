#!/bin/bash

# add timeout to make sure the command exit within 5 seconds
sudo timeout 5 bash -c "test -e /media/root-ro/var/spool/cron/crontabs/pi && overlayroot-chroot /bin/rm /var/spool/cron/crontabs/pi &>/dev/null"