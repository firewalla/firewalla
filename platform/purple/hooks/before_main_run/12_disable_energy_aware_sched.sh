#!/bin/bash

SCHED_FEATURES=/sys/kernel/debug/sched_features

# absent without debugfs or on kernels that lack the feature
sudo grep -qw ENERGY_AWARE "$SCHED_FEATURES" 2>/dev/null || exit 0

echo NO_ENERGY_AWARE | sudo tee "$SCHED_FEATURES" >/dev/null
