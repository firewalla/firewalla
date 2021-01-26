#!/bin/bash

WSROOT=$(git rev-parse --show-toplevel)
$WSROOT/scripts/sanity_check.sh -f
