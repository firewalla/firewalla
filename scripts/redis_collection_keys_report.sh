#!/bin/bash

KEYS="rdns:domain:* rdns:ip:* srdns:pattern:* flow:conn:in:* flow:conn:out:* sumflow:* syssumflow:* aggrflow:* categoryflow:* dynamicCategoryDomain:*"

for KEY in $KEYS; do
  echo "Total number of keys for $KEY:"
  redis-cli keys $KEY | wc -l
  echo "Top 50 big keys for $KEY:"
  (redis-cli keys $KEY | while read KEY; do echo -n "$KEY: "; redis-cli zcount $KEY -inf +inf | awk '{print $1}'; done;) | sort -k2 -n -r | head -n 50
  echo -e "\n\n\n"
done
