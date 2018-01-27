#!/usr/bin/env bash

DIR="$( cd "$( dirname "$0" )" && pwd )"

KEY=$DIR/ssl.key
CRT=$DIR/ssl.crt

if [ -e $KEY ]; then
    rm -f $KEY
fi

if [ -e $CRT ]; then
    rm -f $CRT
fi

openssl req -newkey rsa:1024 -nodes \
-keyout $KEY -x509 -days 365 \
-out $CRT \
-subj "/C=US/ST=New York/L=Brooklyn/O=BLACKHOLE/CN=black-hole.com"