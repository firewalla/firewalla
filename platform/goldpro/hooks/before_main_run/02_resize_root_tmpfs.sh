#!/bin/bash

SIZE='200M'

if mount | fgrep -q 'tmpfs-root on /media/root-rw type tmpfs'; then
  sudo mount -o remount,size=$SIZE /media/root-rw
fi