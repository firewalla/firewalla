#!/bin/bash
# -----------------------------------------
# This is a cloud selector
# -----------------------------------------

select_cloud() {
  FIREAPI_GID=$(redis-cli hget sys:ept gid)
  FIREAPI_URL="http://127.0.0.1:8833/v1/encipher_raw/message/$FIREAPI_GID"

  read -r -d '' FIREAPI_REQ <<EOF
{
      "message": {
          "from": "Unamed",
          "obj" : {
              "mtype": "set",
              "id": "53D8D66E-02BC-44A7-B7C5-B7668FBCC4BA",
              "data": {
                "value": {
                  "instance": "$1"
                },
				        "item": "cloudInstance"
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
  }
EOF

  resp=$(curl -s $FIREAPI_URL \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json' \
      --data-binary "$FIREAPI_REQ" \
      --compressed)
  echo $resp | egrep -q '"code": *200'
}
