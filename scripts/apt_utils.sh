#!/bin/bash

# shared by the apt cron scripts, sourced

apt_cleanup() {
  sudo apt clean
  sudo rm -rf /log/apt/lib/lists/*
}
