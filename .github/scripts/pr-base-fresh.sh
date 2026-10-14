#!/usr/bin/env bash
# Fails when main has moved on since this branch was cut and has changed a path
# whose effect only shows once everything is combined: the installer, the
# deployment, the workflows, the database migrations and the API contract. A
# pull request's checks run against the main it was branched from, so two pull
# requests that each pass can fail together once both are merged.
#
# Usage: pr-base-fresh.sh <main ref> <branch ref>
# Only git is run; nothing from the branch is executed.
set -euo pipefail

main_ref=${1:?main ref}
head_ref=${2:?branch ref}

# Paths where any change on main means the branch must be tested against it.
watched=(install.sh deploy/ .github/workflows/ apps/melete/drizzle/ packages/contracts/)
# How many commits behind main a branch may be when main changed a watched path.
allowed_behind=0

base=$(git merge-base "$main_ref" "$head_ref")
behind=$(git rev-list --count "$base..$main_ref")

if [ "$behind" -le "$allowed_behind" ]; then
  echo "This branch is up to date with main."
  exit 0
fi

changed=$(git diff --name-only "$base" "$main_ref" -- "${watched[@]}")
if [ -z "$changed" ]; then
  echo "Main is $behind commit(s) ahead, with no change to the installer, deployment, workflows, migrations or contract."
  exit 0
fi

echo "Main is $behind commit(s) ahead of this branch and has changed:"
while IFS= read -r path; do echo "  $path"; done <<<"$changed"
echo
echo "Merge main into this branch so CI tests it against current main."
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "::error title=Branch is behind main::Merge main into this branch so CI tests it against current main."
fi
exit 1
