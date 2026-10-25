#!/usr/bin/env bash
# An example of a daily backup that says when it did not run
# (docs/DEPLOYMENT.md, "Backups on a schedule"). Run it from cron or from the
# systemd timer next to it. With nothing set, it backs up into the deploy
# file's backup.dir on this machine. Set:
#
#   MELETE_BACKUP_TO         optional: another machine the backup goes to
#                            instead, ssh://host:/path
#   MELETE_BACKUP_RECIPIENT  the age1... (or ssh-ed25519) public key it is
#                            encrypted to; keep the private half off this
#                            machine. Needed with MELETE_BACKUP_TO, optional
#                            without it.
#   MELETE_BACKUP_PING_URL   optional: a check-in address from a monitor that
#                            alerts you when the pings stop. It is called as it
#                            is after each backup that finishes. After one that
#                            does not, it is called as a failure: /fail is added
#                            to the address's path, before any ?query (the
#                            healthchecks.io style), or, for an Uptime Kuma push
#                            address (its path holds /api/push/), status=down
#                            and msg=backup failed replace those in the query.
#
# Set "backup": { "scheduled": true } in deploy/melete.deploy.json as well, so
# `check` and `status` fail once the newest backup is more than 26 hours old.
# Its backup.keep and backup.max_age_days are applied on the backup host too:
# each run removes this installation's older backups there.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

to="${MELETE_BACKUP_TO:-}"
recipient="${MELETE_BACKUP_RECIPIENT:-}"
ping_url="${MELETE_BACKUP_PING_URL:-}"

# A backup that leaves this machine is always encrypted.
if [ -n "$to" ] && [ -z "$recipient" ]; then
  echo "Set MELETE_BACKUP_RECIPIENT to an age1... public key: a backup sent to $to is encrypted to it." >&2
  exit 2
fi
args=(backup)
if [ -n "$to" ]; then args+=(--to "$to"); fi
if [ -n "$recipient" ]; then args+=(--encrypt-to "$recipient"); fi

# The address that reports a failed backup. Appending /fail to the whole
# address would put it inside a query string (?rid=1/fail, or Uptime Kuma's
# &ping=/fail), which the monitor reads as a success.
fail_url() {
  local url="$1" base query="" kept="" pair
  base="${url%%\?*}"
  if [ "$base" != "$url" ]; then query="${url#*\?}"; fi
  if [[ "$base" == */api/push/* ]]; then
    local IFS='&'
    for pair in $query; do
      case "$pair" in
        status=* | msg=* | '') ;;
        *) kept="${kept}${pair}&" ;;
      esac
    done
    printf '%s?%sstatus=down&msg=backup%%20failed\n' "$base" "$kept"
  else
    printf '%s/fail%s\n' "${base%/}" "${query:+?$query}"
  fi
}

ping() {
  if [ -n "$ping_url" ]; then
    local target="$ping_url"
    if [ "$1" = fail ]; then target="$(fail_url "$ping_url")"; fi
    curl -fsS -m 10 --retry 3 -o /dev/null "$target" || true
  fi
}

if bun run melete "${args[@]}"; then
  ping ok
else
  status=$?
  ping fail
  exit "$status"
fi
