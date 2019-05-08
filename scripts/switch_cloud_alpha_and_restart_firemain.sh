#!/bin/bash

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

source $SCRIPT_DIR/switch_cloud.sh

select_cloud "v0"

sleep 3

sudo systemctl restart firemain