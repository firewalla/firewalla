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
CRON_SCRIPTS_RAW=$(find "$CRON_SCRIPTS_DIR" -maxdepth 1 -name "*.sh" -type f -executable | sort)

if [[ -z "$CRON_SCRIPTS_RAW" ]]; then
    logger "$LOG_TAG:NO_SCRIPTS_FOUND"
    exit 0
fi

readarray -t CRON_SCRIPTS <<< "$CRON_SCRIPTS_RAW"

# Counter for executed scripts
EXECUTED_COUNT=0
FAILED_COUNT=0

logger "$LOG_TAG:FOUND_SCRIPTS:${#CRON_SCRIPTS[@]}"

# Execute each script sequentially
for script in "${CRON_SCRIPTS[@]}"; do
    if [[ -f "$script" && -x "$script" ]]; then
        script_name=$(basename "$script")
        logger "$LOG_TAG:EXECUTING:$script_name"
        
        # Execute the script with timeout and capture exit code
        # detach child script from stdin to avoid interactive prompts
        if timeout 300 bash "$script" </dev/null; then
            logger "$LOG_TAG:SUCCESS:$script_name"
            ((EXECUTED_COUNT++))
        else
            logger "$LOG_TAG:FAILED:$script_name"
            ((FAILED_COUNT++))
        fi
    fi
done

logger "$LOG_TAG:COMPLETED:EXECUTED=$EXECUTED_COUNT:FAILED=$FAILED_COUNT"

# Exit with error if any scripts failed
if [[ $FAILED_COUNT -gt 0 ]]; then
    logger "$LOG_TAG:ERROR:SOME_SCRIPTS_FAILED"
    exit 1
fi

logger "$LOG_TAG:DONE"
exit 0
