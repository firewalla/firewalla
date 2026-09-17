#!/bin/bash

set -u

SITES="${FW_CLOCK_SITES:-cloudflare.com live.com bing.com microsoft.com amazon.com google.com facebook.com time.gov time.is}"
QUORUM="${FW_CLOCK_QUORUM:-3}"
SPREAD="${FW_CLOCK_SPREAD:-5}"
TOLERANCE="${FW_CLOCK_TOLERANCE:-30}"
FLOOR=$(date -d "2026-09-15" +%s)

log(){ logger -t sync_clock "$*"; echo "$*"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for site in $SITES; do
  ( curl -ILsm5 -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' "$site" 2>/dev/null \
      | awk -F': ' '/^[Dd]ate: /{print $2}' | tail -1 > "$tmp/$site" ) &
done
wait

votes=()
for site in $SITES; do
  d=$(cat "$tmp/$site" 2>/dev/null)
  [ -z "$d" ] && continue
  ts=$(date -d "$d" +%s 2>/dev/null) || continue
  [ "$ts" -lt "$FLOOR" ] && continue
  votes+=("$ts")
done

total=$(echo $SITES | wc -w)
if [ "${#votes[@]}" -lt "$QUORUM" ]; then
  log "only ${#votes[@]} of $total sources answered (required $QUORUM), clock untouched"
  exit 1
fi

sorted=($(printf '%s\n' "${votes[@]}" | sort -n))
n=${#sorted[@]}
best_n=0
best_ts=0
for ((i = 0; i < n; i++)); do
  cnt=0
  sum=0
  for ((j = i; j < n; j++)); do
    [ $(( sorted[j] - sorted[i] )) -gt "$SPREAD" ] && break
    cnt=$(( cnt + 1 ))
    sum=$(( sum + sorted[j] ))
  done
  if [ "$cnt" -gt "$best_n" ]; then
    best_n=$cnt
    best_ts=$(( sum / cnt ))
  fi
done

if [ "$best_n" -lt "$QUORUM" ]; then
  log "no quorum: largest cluster is $best_n of $n within ${SPREAD}s (${sorted[*]}), clock untouched"
  exit 1
fi

now=$(date +%s)
diff=$(( best_ts - now ))
if [ "${diff#-}" -le "$TOLERANCE" ]; then
  log "clock ok, ${diff}s off $best_n agreeing sources"
  exit 0
fi

if ! sudo date +%s -s "@$best_ts" >/dev/null; then
  log "failed to set clock to $best_ts"
  exit 1
fi
log "clock moved ${diff}s to $(date -Is) on $best_n agreeing sources"
exit 0
