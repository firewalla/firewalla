#!/bin/bash
# -----------------------------------------
# This is a watch dog function for fireapi.
# In case fireapi hangs, need to restart it.
# -----------------------------------------

TOTAL_RETRIES=6
SLEEP_TIMEOUT=10
FIREAPI_GROUP_MEMBER_COUNT=$(redis-cli hget sys:ept group_member_cnt)

fireapi_ping() {
    FIREAPI_GID=$(redis-cli hget sys:ept gid)
    FIREAPI_GROUP_MEMBER_COUNT=$(redis-cli hget sys:ept group_member_cnt)
    FIREAPI_URL="http://127.0.0.1:8834/v1/encipher/message/$FIREAPI_GID"
    FIREAPI_REQ=$'{
        "message": {
            "from": "Unamed",
            "obj" : {
                "mtype": "cmd",
                "id": "53D8D66E-02BC-44A7-B7C5-B7668FBCC4BA",
                "data": {
                    "item": "ping"
                },
                "type": "jsonmsg",
                "target": "0.0.0.0"
            },
            "appInfo": {
                "appID": "com.rottiesoft.circle",
                "version": "1.18",
                "platform": "ios"
            },
            "msg": "",
            "type": "jsondata",
            "compressMode": 1,
            "mtype": "msg"
        },
        "mtype": "msg"
    }'

    resp=$(curl -s $FIREAPI_URL \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json' \
        --data-binary "$FIREAPI_REQ" \
        --compressed)
   echo $resp | egrep -q '"code": *200'
}

test "$FIREAPI_GROUP_MEMBER_COUNT" -gt 1 || exit 0

retry=1
ping_ok=0
while (( $retry <= $TOTAL_RETRIES ))
do
    if fireapi_ping; then
        ping_ok=1
        break
    fi
    sleep $SLEEP_TIMEOUT
    (( retry++ ))
done

if [[ $ping_ok -ne 1 ]]; then
    /home/pi/firewalla/scripts/firelog -t cloud -m "FireAPI ping FAILED, restart FireAPI now $FIREAPI_GID"
    touch /home/pi/.firewalla/managed_reboot
    sudo systemctl restart fireapi
fi


