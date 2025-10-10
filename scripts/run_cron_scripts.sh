#!/bin/bash

# Run all shell scripts in /home/pi/firewalla/scripts/cron directory sequentially
# This script ensures all cron scripts are executed in order during system preparation

CRON_SCRIPTS_DIR="/home/pi/firewalla/scripts/cron"
LOG_TAG="FIREWALLA:CRON_SCRIPTS_RUNNER"

logger "$LOG_TAG:START"

# Check if cron scripts directory exists
if [[ ! -d "$CRON_SCRIPTS_DIR" ]]; then
    logger "$LOG_TAG:CRON_SCRIPTS_DIR_NOT_FOUND:$CRON_SCRIPTS_DIR"
    exit 0
fi

# Find all shell scripts in the cron directory and sort them
# This ensures consistent execution order
CRON_SCRIPTS=$(find "$CRON_SCRIPTS_DIR" -maxdepth 1 -name "*.sh" -type f -executable | sort)

if [[ -z "$CRON_SCRIPTS" ]]; then
    logger "$LOG_TAG:NO_SCRIPTS_FOUND"
    exit 0
fi

# Counter for executed scripts
EXECUTED_COUNT=0
FAILED_COUNT=0

logger "$LOG_TAG:FOUND_SCRIPTS:$(echo "$CRON_SCRIPTS" | wc -l)"

# Execute each script sequentially
while IFS= read -r script; do
    if [[ -f "$script" && -x "$script" ]]; then
        script_name=$(basename "$script")
        logger "$LOG_TAG:EXECUTING:$script_name"
        
        # Execute the script with timeout and capture exit code
        if timeout 300 bash "$script"; then
            logger "$LOG_TAG:SUCCESS:$script_name"
            ((EXECUTED_COUNT++))
        else
            logger "$LOG_TAG:FAILED:$script_name"
            ((FAILED_COUNT++))
        fi
    fi
done <<< "$CRON_SCRIPTS"

logger "$LOG_TAG:COMPLETED:EXECUTED=$EXECUTED_COUNT:FAILED=$FAILED_COUNT"

# Exit with error if any scripts failed
if [[ $FAILED_COUNT -gt 0 ]]; then
    logger "$LOG_TAG:ERROR:SOME_SCRIPTS_FAILED"
    exit 1
fi

logger "$LOG_TAG:DONE"
exit 0
