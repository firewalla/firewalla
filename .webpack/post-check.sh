#!/usr/bin/env bash

cov=$1
cov=${cov%"%"}
if (( $(echo "$cov < $2" | bc -l) )); then
    echo "Code coverage is less than ${2}%. Job failed."
    exit 1
else
    echo "Job succeed."
fi
