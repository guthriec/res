#!/usr/bin/env bash
set -euo pipefail

CHANNEL_NAME="hacker-news"
CHANNEL_ID="$CHANNEL_NAME"
FEED_URL="https://hnrss.org/frontpage"
REFRESH_INTERVAL="3600"
LOCK_NAME="news-summarization"

FETCH_PARAM_JSON="{\"url\":\"$FEED_URL\"}"
 
if res channel view "$CHANNEL_ID" >/dev/null 2>&1; then
  res channel edit "$CHANNEL_ID" \
    --type rss \
    --fetch-param "$FETCH_PARAM_JSON" \
    --refresh-interval "$REFRESH_INTERVAL" >/dev/null
else
  res channel add "$CHANNEL_NAME" \
    --type rss \
    --fetch-param "$FETCH_PARAM_JSON" \
    --refresh-interval "$REFRESH_INTERVAL" >/dev/null
fi

res retain channel "$CHANNEL_ID" "$LOCK_NAME" >/dev/null