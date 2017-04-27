#!/bin/bash

function get_number_of_flows()
{
  FLOW=$1
  TIMESTAMP_BEGIN=$2
  TIMESTAMP_END=$3

  redis-cli --raw zcount $FLOW $TIMESTAMP_BEGIN $TIMESTAMP_END
}

function flow_group_by_hour()
{
  FLOW=$1
  TOTAL_END=$2

  echo "+++++++ get flows distribution for $FLOW (group by hours in reverse order) +++++++"
  for i in `seq 1 24`; do
    BEGIN=$(echo "$TOTAL_END - $i * 3600" | bc);
    END=$(echo "$TOTAL_END - ($i - 1) * 3600" | bc);
    get_number_of_flows $FLOW $BEGIN $END
  done
}

cd `dirname $0`
echo "######################"
echo "####### MEMORY #######"
top -b -n 1 -o %MEM | head -n 20
echo "####### SYSINFO ######"
node ../test/test_sysinfo.js
echo "####### Top 5 FLOWS ##"
FLOWS=$(redis-cli --raw keys 'flow:conn*')
FLOW_TMP_FILE=/tmp/get_stats.$RANDOM
touch $FLOW_TMP_FILE
for flow in $FLOWS; do
  (echo -n "$flow ";redis-cli --raw zcount $flow -inf +inf) >> $FLOW_TMP_FILE
done
FLOW_TMP_FILE2=/tmp/get_stats2.$RANDOM
sort -k 2 -n $FLOW_TMP_FILE -r | head -n 5 | tee $FLOW_TMP_FILE2
TOP_FLOWS=$(cat $FLOW_TMP_FILE2 | awk '{print $1}')
NOW=$(date +%s)

for flow in $TOP_FLOWS; do
  flow_group_by_hour $flow $NOW
done
