#!/bin/bash

# get workspace root
WSROOT=$(git rev-parse --show-toplevel)

# do sanity check
$WSROOT/scripts/sanity_check.sh -f
