#!/bin/bash

ls /etc/ssh/ssh_host_* &>/dev/null || sudo dpkg-reconfigure openssh-server &> /dev/null
