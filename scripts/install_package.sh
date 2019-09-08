#!/bin/bash

usage() {
    echo Usage: install_package [-uh] package
    return
}

PARAMS=""
UPDATE=false

while [[ "$1" != "" ]]; do
    case $1 in
        -u )    shift
                UPDATE=true
                ;;
        -h )    usage
                exit
                ;;
        * )     PARAMS="$PARAMS $1"
                shift
                ;;
    esac
done

eval set -- "$PARAMS"

if [[ -z "$1" ]]; then
    echo "Error: package name missing"
    exit 1
fi

if [[ "$UPDATE" == true ]]; then
    echo "Updating package list"
    sudo apt-get update
fi

echo "Installing package $1"
APTRESULT="$(sudo apt-get install $1 -y -q 2>&1)"
echo "$APTRESULT"

if [[ $APTRESULT =~ 'dpkg --configure -a' ]]; then
    sudo dpkg --configure -a
    sudo apt-get install $1 -y -q
fi

