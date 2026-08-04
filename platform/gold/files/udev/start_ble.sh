#!/bin/bash

# triggering BLE restart in udev rule directly won't success as device is not available
sleep 2
redis-cli publish firereset.ble.control.timeout 1
