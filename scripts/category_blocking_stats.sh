#!/bin/bash

CATEGORY_LIST=`sudo ipset list -name | egrep "^c_category"`

for category in $CATEGORY_LIST; do
  NUM_ENTRIES=`sudo ipset list -t $category | tail -n 1 | sed 's/Number of entries: //'`
  echo "${category} ${NUM_ENTRIES}"
done