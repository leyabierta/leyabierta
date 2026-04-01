#!/usr/bin/env bash
# Send, update, get, or set-status on a notification message in a Trilo project channel via Bot REST API.
#
# Usage:
#   Send a new message:           trilo-notify.sh send <message>
#   Update existing message:      trilo-notify.sh update <message-id> <message>
#   Get message content:          trilo-notify.sh get <message-id>
#   Update one app's status line: trilo-notify.sh set-status <message-id> <app-name> <new-line>
#
# Required env vars:
#   TRILO_BOT_TOKEN     - Bot token (trilo_bot_...)
#   TRILO_PROJECT_ID    - Target project UUID
#   TRILO_BACKEND_URL   - Backend API URL (e.g. https://api.trilo.chat)
#
# Output (send mode):
#   Prints the message ID to stdout on success (for capturing in CI)
# Output (get mode):
#   Prints the message content to stdout

set -euo pipefail

ACTION="${1:?Usage: trilo-notify.sh send|update|get|set-status <args>}"
API_URL="${TRILO_BACKEND_URL}/api/bot/v1"
MAX_RETRIES=5
RETRY_DELAY=10  # seconds between retries

# Retry wrapper for curl — handles brief backend downtime during deploys
retry_curl() {
  local attempt=1
  local result=""
  while [ $attempt -le $MAX_RETRIES ]; do
    if result=$(curl -sf "$@" 2>/dev/null); then
      echo "$result"
      return 0
    fi
    if [ $attempt -lt $MAX_RETRIES ]; then
      echo "::notice::Trilo notify: attempt $attempt/$MAX_RETRIES failed, retrying in ${RETRY_DELAY}s..." >&2
      sleep "$RETRY_DELAY"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

case "$ACTION" in
  send)
    MESSAGE="${2:?Usage: trilo-notify.sh send <message>}"
    ESCAPED_MSG=$(echo "$MESSAGE" | jq -Rs '.')

    RESULT=$(retry_curl -X POST "${API_URL}/projects/${TRILO_PROJECT_ID}/messages" \
      -H "Authorization: Bearer ${TRILO_BOT_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"content\":${ESCAPED_MSG}}") || {
      echo "::warning::Trilo notify: failed to send message after $MAX_RETRIES attempts" >&2
      exit 0
    }

    MSG_ID=$(echo "$RESULT" | jq -r '.data.id' 2>/dev/null)
    if [ -n "$MSG_ID" ] && [ "$MSG_ID" != "null" ]; then
      echo "$MSG_ID"
    else
      echo "::warning::Trilo notify: could not extract message ID" >&2
    fi
    ;;

  update)
    MESSAGE_ID="${2:?Usage: trilo-notify.sh update <message-id> <message>}"
    MESSAGE="${3:?Usage: trilo-notify.sh update <message-id> <message>}"
    ESCAPED_MSG=$(echo "$MESSAGE" | jq -Rs '.')

    if [ -z "$MESSAGE_ID" ] || [ "$MESSAGE_ID" = "null" ]; then
      echo "::warning::Trilo notify: no message ID to update, skipping" >&2
      exit 0
    fi

    retry_curl -X PATCH "${API_URL}/messages/${MESSAGE_ID}" \
      -H "Authorization: Bearer ${TRILO_BOT_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"content\":${ESCAPED_MSG}}" > /dev/null || {
      echo "::warning::Trilo notify: failed to update message after $MAX_RETRIES attempts" >&2
      exit 0
    }

    echo "Trilo notification updated" >&2
    ;;

  get)
    MESSAGE_ID="${2:?Usage: trilo-notify.sh get <message-id>}"

    if [ -z "$MESSAGE_ID" ] || [ "$MESSAGE_ID" = "null" ]; then
      echo "::warning::Trilo notify: no message ID to get, skipping" >&2
      exit 0
    fi

    RESULT=$(retry_curl -X GET "${API_URL}/messages/${MESSAGE_ID}" \
      -H "Authorization: Bearer ${TRILO_BOT_TOKEN}") || {
      echo "::warning::Trilo notify: failed to get message after $MAX_RETRIES attempts" >&2
      exit 0
    }

    echo "$RESULT" | jq -r '.data.content' 2>/dev/null
    ;;

  set-status)
    MESSAGE_ID="${2:?Usage: trilo-notify.sh set-status <message-id> <app-name> <new-line>}"
    APP_NAME="${3:?Usage: trilo-notify.sh set-status <message-id> <app-name> <new-line>}"
    NEW_LINE="${4:?Usage: trilo-notify.sh set-status <message-id> <app-name> <new-line>}"

    if [ -z "$MESSAGE_ID" ] || [ "$MESSAGE_ID" = "null" ]; then
      echo "::warning::Trilo notify: no message ID for set-status, skipping" >&2
      exit 0
    fi

    # Fetch current message content
    CURRENT=$("$0" get "$MESSAGE_ID")
    if [ -z "$CURRENT" ]; then
      echo "::warning::Trilo notify: could not fetch message for set-status" >&2
      exit 0
    fi

    # Replace the line containing **app-name** with the new line
    UPDATED=$(echo "$CURRENT" | awk -v app="**${APP_NAME}**" -v newline="$NEW_LINE" '{
      if (index($0, app) > 0) {
        print newline
      } else {
        print
      }
    }')

    # Write back via update
    ESCAPED_MSG=$(echo "$UPDATED" | jq -Rs '.')
    retry_curl -X PATCH "${API_URL}/messages/${MESSAGE_ID}" \
      -H "Authorization: Bearer ${TRILO_BOT_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"content\":${ESCAPED_MSG}}" > /dev/null || {
      echo "::warning::Trilo notify: failed to set-status after $MAX_RETRIES attempts" >&2
      exit 0
    }

    echo "Trilo notification status updated for ${APP_NAME}" >&2
    ;;

  *)
    echo "Usage: trilo-notify.sh send|update|get|set-status <args>" >&2
    exit 1
    ;;
esac
