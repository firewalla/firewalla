#!/bin/bash

(which qrencode &>/dev/null || (sudo dpkg --configure -a; sudo apt-get update && sudo apt-get install -y qrencode) ) &>/dev/null &