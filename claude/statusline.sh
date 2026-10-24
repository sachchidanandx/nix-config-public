#!/usr/bin/env zsh
#
# Claude Code Status Line — Full Featured (Emoji Style)
#
# ┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
# │ DISPLAY FORMAT                                                                                                                              │
# │ 🤖 Model 🌔 (Context: 🟢 X% (Xk/Yk) | MCP: N/M | $X.XX | ⏱ Nm | +N/-M) | 📂 dir 🌳worktree | 🌿 branch ↑N↓M | PR#N ✅ ✅ 💬N | ⏳ AWS:XhYYm │
# └─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
#
# CONTEXT USAGE:
#   🟢 = ≤40% (safe)     🟡 = 41-59% (moderate)
#   🟠 = 60-79% (warning) 🔴 = ≥80% (critical)
#
# EFFORT LEVEL (moon fills up with effort; hidden when the model has no effort setting):
#   🌒 = low  🌓 = medium  🌔 = high  🌕 = xhigh  🌟 = max
#
# MCP:
#   N/M = enabled/total from ~/.claude.json and <project>/.mcp.json (plugin MCP servers not counted)
#
# COMMIT STATUS (vs remote):
#   ↑N = ahead  ↓N = behind  ↑N↓M = diverged
#
# PR CI CHECKS:
#   ⏳ = none  🔄(N) = pending  ✅ = passed  ❌(N) = failed
#
# PR REVIEW:
#   ✅ = approved  🔴 = changes requested  👀 = review required  ⚪ = none
#
# COST & DURATION:
#   $X.XX = session cost   ⏱ Ns / Nm / NhNm = total duration
#   +N/-M = lines added/removed
#
# AWS SSO (expiresAt from ~/.aws/sso/cache; refreshed by aws-sso-refresh.sh via awsAuthRefresh):
#   ⏳ AWS:XhYYm = >1h left   ⌛ AWS:Xm = <1h left   🪦 AWS:exp@H:MMpm = expired
#
# WORKTREE:
#   🌳 name = active git worktree session
#
# PR DATA:
#   Whether a PR exists comes from Claude Code's `pr` field on stdin (no gh call when absent).
#   CI/review/comment details come from `gh pr view`, cached per repo+branch in /tmp:
#     fresh (<10s) → shown as-is; stale → shown immediately and refreshed in the background
#     (Claude Code cancels slow in-flight scripts); missing → fetched synchronously.
#   All other data is always fresh from stdin.
#

emulate zsh
setopt pipe_fail extended_glob
zmodload zsh/stat zsh/datetime

readonly PR_CACHE_TTL=10   # seconds a cached PR section counts as fresh
readonly PR_LOCK_TTL=60    # seconds after which a refresh lock is considered abandoned

typeset -gA EFFORT_ICON=(low 🌒 medium 🌓 high 🌔 xhigh 🌕 max 🌟)

# ─── Input ────────────────────────────────────────────────────────────────────
# One jq call; fields are joined with the ASCII unit separator so empty values
# survive splitting (no eval, no word splitting).
parse_input() {
  local -a f
  f=("${(@ps:\x1f:)$(jq -r '[
      (.model.display_name // .model.displayName // "unknown"),
      (.workspace.current_dir // .cwd // "unknown"),
      (.workspace.project_dir // ""),
      (.cost.total_cost_usd // 0),
      (.cost.total_duration_ms // 0 | floor),
      (.cost.total_lines_added // 0),
      (.cost.total_lines_removed // 0),
      (.context_window.context_window_size // 0),
      (.context_window.used_percentage | if . == null then "" else floor end),
      (.context_window.current_usage // {}
        | (.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)),
      (.effort.level // ""),
      (.worktree.name // ""),
      (.worktree.branch // ""),
      (.pr.number // ""),
      (.pr.review_state // "")
    ] | map(tostring) | join("\u001f")' 2>/dev/null)}")

  typeset -g model=$f[1] cwd=$f[2] project_dir=$f[3] \
    session_cost=$f[4] total_duration_ms=$f[5] lines_added=$f[6] lines_removed=$f[7] \
    context_size=$f[8] used_pct=$f[9] usage_tokens=$f[10] effort_level=$f[11] \
    worktree_name=$f[12] worktree_branch=$f[13] pr_number=$f[14] pr_review_state=$f[15]
  typeset -g root_dir=${project_dir:-$cwd}
}

# ─── Helpers ──────────────────────────────────────────────────────────────────
# Run git against the session's directory, not this script's cwd
g() { git -C "$cwd" "$@"; }

# basename(1) without the fork
base_name() {
  local p=${1%%/##}
  if [[ -z $p && -n $1 ]]; then print -rn -- /; else print -rn -- ${p:t}; fi
}

# 999 → 999, 200000 → 200k, 87250 → 87.2k
format_tokens_k() {
  local -i n=$1
  if (( n < 1000 )); then
    printf '%d' $n
  elif (( n % 1000 == 0 )); then
    printf '%dk' $(( n / 1000 ))
  else
    printf '%.1fk' $(( n / 1000. ))
  fi
}

# ms → ⏱ Ns / Nm / NhNm (nothing for 0)
format_duration() {
  local -i secs=$(( $1 / 1000 ))
  (( $1 )) || return
  if (( secs < 60 )); then
    printf '⏱ %ds' $secs
  elif (( secs < 3600 )); then
    printf '⏱ %dm' $(( secs / 60 ))
  else
    printf '⏱ %dh%dm' $(( secs / 3600 )) $(( secs % 3600 / 60 ))
  fi
}

# Seconds since a file was modified; fails if it doesn't exist
file_age() {
  local -a mtime
  zstat -A mtime +mtime -- $1 2>/dev/null || return 1
  print -rn -- $(( EPOCHSECONDS - mtime[1] ))
}

# ─── Model block segments ────────────────────────────────────────────────────
context_segment() {
  [[ $context_size == <1-> ]] || return
  local -i tokens=${usage_tokens:-0} pct

  if [[ $used_pct == <-> ]]; then
    pct=$used_pct
  else
    pct=$(( tokens * 100 / context_size ))
    (( pct > 100 )) && pct=100
  fi

  local icon
  if (( pct <= 40 )); then icon=🟢
  elif (( pct < 60 )); then icon=🟡
  elif (( pct < 80 )); then icon=🟠
  else icon=🔴
  fi
  print -rn -- "Context: $icon $pct% ($(format_tokens_k $tokens)/$(format_tokens_k $context_size))"
}

mcp_segment() {
  local -i total=0 disabled=0 enabled
  local user project project_disabled count count_disabled

  if [[ -f $HOME/.claude.json ]]; then
    read -r user project project_disabled < <(jq -r --arg dir "$root_dir" '
      [(.mcpServers | length), (.projects[$dir].mcpServers | length), (.projects[$dir].disabledMcpServers | length)] | @tsv
    ' $HOME/.claude.json 2>/dev/null)
    (( total += ${user:-0} + ${project:-0} ))
    disabled=${project_disabled:-0}
  fi

  if [[ -f $root_dir/.mcp.json ]]; then
    read -r count count_disabled < <(jq -r '
      [(.mcpServers | length), ([.mcpServers // {} | to_entries[] | select(.value.disabled == true)] | length)] | @tsv
    ' $root_dir/.mcp.json 2>/dev/null)
    (( total += ${count:-0}, disabled += ${count_disabled:-0} ))
  fi

  (( total )) || return
  enabled=$(( total > disabled ? total - disabled : 0 ))
  print -rn -- "MCP: $enabled/$total"
}

cost_segment() {
  [[ -n $session_cost && $session_cost != 0 ]] || return
  [[ $session_cost == [-+0-9.eE]## ]] || return
  printf '$%.2f' $session_cost
}

duration_segment() {
  [[ $total_duration_ms == <1-> ]] && format_duration $total_duration_ms
}

lines_segment() {
  [[ ${lines_added:-0} != 0 || ${lines_removed:-0} != 0 ]] || return
  print -rn -- "+${lines_added:-0}/-${lines_removed:-0}"
}

model_segment() {
  local out="🤖 $model"
  [[ $effort_level == [a-z]## && -n ${EFFORT_ICON[$effort_level]} ]] && out+=" ${EFFORT_ICON[$effort_level]}"

  local -a parts=("$(context_segment)" "$(mcp_segment)" "$(cost_segment)" "$(duration_segment)" "$(lines_segment)")
  parts=(${parts:#})
  (( $#parts )) && out+=" (${(j: | :)parts})"
  print -rn -- $out
}

dir_segment() {
  print -rn -- "📂 $(base_name $cwd)${worktree_name:+ 🌳$worktree_name}"
}

# ─── Git ──────────────────────────────────────────────────────────────────────
# Sets globals: branch, is_detached
resolve_branch() {
  typeset -g branch=$(g branch --show-current 2>/dev/null)
  [[ -z $branch ]] && branch="HEAD:$(g rev-parse --short HEAD 2>/dev/null || echo unknown)"
  # Use worktree branch if available and we're in a worktree
  [[ -n $worktree_branch ]] && branch=$worktree_branch
  typeset -gi is_detached=0
  [[ $branch == HEAD:* ]] && is_detached=1
}

git_segment() {
  local commit_status ahead behind
  # Fails (no output) when there's no upstream → no status
  if (( ! is_detached )) &&
    read -r ahead behind < <(g rev-list --left-right --count 'HEAD...@{u}' 2>/dev/null); then
    if (( ahead && behind )); then commit_status=" ↑${ahead}↓${behind}"
    elif (( ahead )); then commit_status=" ↑${ahead}"
    elif (( behind )); then commit_status=" ↓${behind}"
    fi
  fi
  print -rn -- "🌿 $branch$commit_status"
}

# ─── PR ───────────────────────────────────────────────────────────────────────
# Fetch PR details with gh, render the section into $REPLY and atomically
# write it to the cache file $1
refresh_pr_cache() {
  local file=$1 tmp=$1.$$ out section
  out=$(cd -q -- $cwd 2>/dev/null &&
    gh pr view $branch --json number,state,statusCheckRollup,reviewDecision,comments 2>/dev/null |
    jq -r '(.statusCheckRollup // []) as $checks | [
        .number,
        ($checks | length),
        ([$checks[] | select(.conclusion == "FAILURE" or .state == "FAILURE")] | length),
        ([$checks[] | select(.conclusion == "PENDING" or .status == "IN_PROGRESS" or .status == "QUEUED"
          or .state == "PENDING" or (.status == "COMPLETED" and .conclusion == null))] | length),
        (.reviewDecision // "NONE"),
        (.comments | length)
      ] | map(tostring) | join("\u001f")' 2>/dev/null)

  if (( $? )) || [[ -z $out ]]; then
    section="📝 No PR"
  else
    local -a f=("${(@ps:\x1f:)out}")
    local number=$f[1] review=$f[5] ci review_icon comments
    local -i all=$f[2] failed=$f[3] pending=$f[4] ncomments=$f[6]

    if (( all == 0 )); then ci="⏳"
    elif (( failed )); then ci="❌($failed)"
    elif (( pending )); then ci="🔄($pending)"
    else ci="✅"
    fi

    case $review in
      APPROVED) review_icon="✅" ;;
      CHANGES_REQUESTED) review_icon="🔴" ;;
      REVIEW_REQUIRED) review_icon="👀" ;;
      *) review_icon="⚪" ;;
    esac

    (( ncomments )) && comments=" 💬$ncomments"
    section="PR#$number $ci $review_icon$comments"
  fi

  REPLY=$section
  print -rn -- $section >| $tmp && mv -f -- $tmp $file
  rm -f -- $tmp
}

# Refresh in the background so the statusline returns immediately. A mkdir lock
# (taken here, before forking) keeps it to one refresh per cache file.
refresh_pr_cache_async() {
  local file=$1 lock=$1.lock age
  if ! mkdir -- $lock 2>/dev/null; then
    age=$(file_age $lock) && (( age >= PR_LOCK_TTL )) || return
    rmdir -- $lock 2>/dev/null
    mkdir -- $lock 2>/dev/null || return
  fi
  # Ignore signals so Claude Code cancelling this script doesn't kill the refresh
  (
    trap '' HUP INT TERM
    refresh_pr_cache $file
    rmdir -- $lock 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &!
}

pr_segment() {
  if (( is_detached )); then print -rn -- "🔀 Detached"; return; fi
  # Claude Code omits `pr` when the branch has no open PR
  if [[ -z $pr_number ]]; then print -rn -- "📝 No PR"; return; fi

  local key=$(g rev-parse --show-toplevel 2>/dev/null | cksum)
  local file="/tmp/claude-pr-data-${key%% *}-${branch//\//_}" age

  if age=$(file_age $file); then
    (( age >= PR_CACHE_TTL )) && refresh_pr_cache_async $file
    print -rn -- "$(<$file)"
  else
    refresh_pr_cache $file
    print -rn -- $REPLY
  fi
}

# ─── AWS SSO ──────────────────────────────────────────────────────────────────
# Time left on the SSO session: the cache file holding an accessToken (the
# others are client registrations)
aws_segment() {
  local -a files=($HOME/.aws/sso/cache/*.json(N))
  (( $#files )) || return
  local ts epoch expiry
  ts=$(jq -rn 'first(inputs | select(has("accessToken")) | .expiresAt // empty)' $files 2>/dev/null)
  [[ -n $ts ]] || return

  # "2026-05-10T01:00:00Z" or "2026-05-10T01:00:00.000Z"
  TZ=UTC strftime -r -s epoch '%Y-%m-%dT%H:%M:%SZ' ${ts/.<->Z/Z} 2>/dev/null || return
  local -i left=$(( epoch - EPOCHSECONDS ))

  if (( left <= 0 )); then
    strftime -s expiry '%-I:%M%p' $epoch
    print -rn -- "🪦 AWS:exp@${(L)expiry}"
  elif (( left < 3600 )); then
    printf '⌛ AWS:%dm' $(( left / 60 ))
  else
    printf '⏳ AWS:%dh%02dm' $(( left / 3600 )) $(( left % 3600 / 60 ))
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────
main() {
  parse_input
  local head="$(model_segment) | $(dir_segment)" aws=$(aws_segment)

  if ! g rev-parse --git-dir &>/dev/null; then
    print -r -- "$head | ⚠️ Not a git repo${aws:+ | $aws}"
    return
  fi

  resolve_branch
  print -r -- "$head | $(git_segment) | $(pr_segment)${aws:+ | $aws}"
}

main
