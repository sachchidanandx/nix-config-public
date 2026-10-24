#!/bin/bash
#
# AWS SSO Token Refresh
#
# Checks the SSO cache expiry and refreshes the token using
# `aws sso-oidc create-token` with the refresh_token grant.
# This directly renews the access token without opening a browser.
#
# Run by Claude Code via `awsAuthRefresh` in settings.json; exits non-zero
# when the refresh token is gone so the `aws sso login` fallback runs.
# No-op if session is healthy.
#

CACHE_DIR="$HOME/.aws/sso/cache"
LOG="$HOME/.claude/aws-sso-refresh.log"
REFRESH_THRESHOLD=600 # Refresh if < 10 minutes remain
FORCE=false
[ "$1" = "--force" ] && FORCE=true

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >>"$LOG"
}

# Keep log from growing forever (keep last 100 lines)
if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 200 ]; then
  tail -100 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# Find the session cache file (has accessToken)
CACHE_FILE=""
expires_at=""
for f in "$CACHE_DIR"/*.json; do
  [ -f "$f" ] || continue
  has_token=$(jq -r 'has("accessToken")' "$f" 2>/dev/null)
  if [ "$has_token" = "true" ]; then
    CACHE_FILE="$f"
    expires_at=$(jq -r '.expiresAt // empty' "$f" 2>/dev/null)
    break
  fi
done

if [ -z "$CACHE_FILE" ] || [ -z "$expires_at" ]; then
  log "SKIP: No active SSO session found in cache"
  exit 0
fi

# Parse expiry time
clean_ts=$(echo "$expires_at" | sed 's/\.[0-9]*Z$/Z/')
expiry_epoch=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%SZ" "$clean_ts" "+%s" 2>/dev/null ||
  date -d "$expires_at" "+%s" 2>/dev/null)

if [ -z "$expiry_epoch" ]; then
  log "ERROR: Could not parse expiresAt: $expires_at"
  exit 1
fi

now=$(date +%s)
secs_left=$((expiry_epoch - now))

if [ "$secs_left" -gt "$REFRESH_THRESHOLD" ] && [ "$FORCE" = false ]; then
  log "OK: Session valid for $((secs_left / 60))m — no refresh needed"
  exit 0
fi

if [ "$secs_left" -le 0 ]; then
  log "EXPIRING: Token expired $(((-secs_left) / 60))m ago — refreshing"
else
  log "EXPIRING: Only $((secs_left / 60))m left — refreshing"
fi

# Extract credentials from cache
CLIENT_ID=$(jq -r '.clientId' "$CACHE_FILE")
CLIENT_SECRET=$(jq -r '.clientSecret' "$CACHE_FILE")
REFRESH_TOKEN=$(jq -r '.refreshToken' "$CACHE_FILE")
REGION=$(jq -r '.region // "us-west-2"' "$CACHE_FILE")

if [ -z "$REFRESH_TOKEN" ] || [ "$REFRESH_TOKEN" = "null" ]; then
  log "FAILED: No refresh token in cache — browser login required"
  exit 1
fi

# Call SSO OIDC to get a fresh access token using the refresh token
RESPONSE=$(aws sso-oidc create-token \
  --client-id "$CLIENT_ID" \
  --client-secret "$CLIENT_SECRET" \
  --grant-type "refresh_token" \
  --refresh-token "$REFRESH_TOKEN" \
  --region "$REGION" 2>&1)

if [ $? -ne 0 ]; then
  log "FAILED: sso-oidc create-token failed — $RESPONSE"
  log "FAILED: Refresh token may be expired — browser login required"
  exit 1
fi

# Extract new tokens from response
NEW_ACCESS_TOKEN=$(echo "$RESPONSE" | jq -r '.accessToken // empty')
NEW_REFRESH_TOKEN=$(echo "$RESPONSE" | jq -r '.refreshToken // empty')
EXPIRES_IN=$(echo "$RESPONSE" | jq -r '.expiresIn // 3600')

if [ -z "$NEW_ACCESS_TOKEN" ]; then
  log "FAILED: No access token in response"
  exit 1
fi

# Calculate new expiry timestamp
NEW_EXPIRY=$(date -u -j -f "%s" "$((now + EXPIRES_IN))" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ||
  date -u -d "@$((now + EXPIRES_IN))" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)

# Update cache file atomically
jq --arg at "$NEW_ACCESS_TOKEN" \
  --arg rt "${NEW_REFRESH_TOKEN:-$REFRESH_TOKEN}" \
  --arg exp "$NEW_EXPIRY" \
  '.accessToken = $at | .refreshToken = $rt | .expiresAt = $exp' \
  "$CACHE_FILE" >"$CACHE_FILE.tmp" && mv "$CACHE_FILE.tmp" "$CACHE_FILE"

log "REFRESHED: New expiry $NEW_EXPIRY (${EXPIRES_IN}s)"
