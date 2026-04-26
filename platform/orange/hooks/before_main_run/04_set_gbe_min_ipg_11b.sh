#!/bin/bash

gbe_file=$(find /sys/bus/mdio_bus/devices/mdio-bus\:*/ -name gbe_min_ipg_11B 2>/dev/null | head -1)
[[ -n "$gbe_file" ]] || return 0

sudo bash -c "echo 1 > '$gbe_file'"