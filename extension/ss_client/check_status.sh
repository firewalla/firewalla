#!/bin/bash

ps aux | grep fw_ss | grep -v grep
ps aux | grep chinadns | grep -v grep
sudo iptables -w -t nat -n -L

