#!/bin/bash

sudo bash -c 'echo "install algif_aead /bin/false" > /etc/modprobe.d/disable-algif-aead.conf'
sudo rmmod algif_aead 2>/dev/null || true
