#!/bin/bash

# this script should be removed in 1.974 once all tracking data has been cleaned nicely in 1.973
redis-cli keys 'tracking:*' | xargs -n 50 redis-cli del &>/dev/null
