#!/usr/bin/env bash
set -euo pipefail

CHANNEL_ID="hacker-news"
LOCK_NAME="news-summarization"
MODEL="${OLLAMA_MODEL:-mistral-nemo:latest}"
OLLAMA_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
MAX_ITEMS="25"
OUTPUT_BASE="news-summaries-$(date +%F)"

BATCH_INDEX=1

while true; do
  OUTPUT_FILE="${OUTPUT_BASE}-batch-${BATCH_INDEX}.md"

  ITEMS_JSON=$(res content list \
    --channels "$CHANNEL_ID" \
    --retained true \
    --retained-by "$LOCK_NAME" \
    --page-size "$MAX_ITEMS")

  ITEM_COUNT=$(echo "$ITEMS_JSON" | jq 'length')
  [[ "$ITEM_COUNT" -eq 0 ]] && break

  CONTEXT=""
  BATCH_COUNT=0
  MIN_ID=""
  MAX_ID=""

  while IFS= read -r item; do
    ID=$(echo "$item" | jq -r '.id // empty')
    PATH_REL=$(echo "$item" | jq -r '.filePath // empty')
    TITLE=$(echo "$item" | jq -r '.title // "(untitled)"')

    if [[ -z "$MIN_ID" || "$ID" -lt "$MIN_ID" ]]; then MIN_ID="$ID"; fi
    if [[ -z "$MAX_ID" || "$ID" -gt "$MAX_ID" ]]; then MAX_ID="$ID"; fi

    CONTENT=$(cat "$PATH_REL")
    CONTEXT+="\n\n### Post\n"
    CONTEXT+="Title: $TITLE\n"
    CONTEXT+="$CONTENT"

    BATCH_COUNT=$((BATCH_COUNT + 1))
  done < <(echo "$ITEMS_JSON" | jq -c '.[] | select(.id and .filePath)')

  if [[ "$BATCH_COUNT" -eq 0 ]]; then
    break
  fi

  PROMPT=$(printf '%s\n' \
    'You are summarizing multiple Hacker News posts for a personal notes vault.' \
    'Pick the most interesting and relevant posts from the provided context.' \
    'Return markdown only with these sections:' \
    '1) Top Picks (ranked bullets with short reasons)' \
    '2) Combined Summary (concise bullets)' \
    '3) Notable Themes (short bullets)' \
    'Ground claims in the provided content only.' \
    '' \
    'Posts context:' \
    "$CONTEXT")

  PAYLOAD=$(jq -cn --arg model "$MODEL" --arg prompt "$PROMPT" '{model: $model, prompt: $prompt, stream: false}')
  RESPONSE=$(curl -sS -H 'Content-Type: application/json' -X POST "$OLLAMA_URL/api/generate" --data-binary "$PAYLOAD")
  SUMMARY=$(echo "$RESPONSE" | jq -r '.response // empty')

  [[ -z "$SUMMARY" ]] && { echo "Ollama response missing summary" >&2; exit 1; }

  {
    echo "## Hacker News digest - batch ${BATCH_INDEX} ($(date -u +"%Y-%m-%dT%H:%M:%SZ"))"
    echo
    printf '%s\n' "$SUMMARY"
    echo
    echo '---'
    echo
  } >> "$OUTPUT_FILE"

  res release range "$LOCK_NAME" --from "$MIN_ID" --to "$MAX_ID" --channel "$CHANNEL_ID" >/dev/null

  BATCH_INDEX=$((BATCH_INDEX + 1))

done
