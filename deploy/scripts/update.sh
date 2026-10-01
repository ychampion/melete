#!/usr/bin/env bash
# Updates an installation that runs the published images (docs/DEPLOYMENT.md,
# "Using prebuilt images"). Nothing is built on this machine.
#
#   deploy/scripts/update.sh [compose options...]
#
# Any arguments are passed to every `docker compose` call, for example
# `--profile sandbox` when the agents' computer image is in use, or the same
# `-f` overlay files the installation was started with.
#
# The order is the safe one:
#   1. refuse when the disk holding Docker's data is short of space;
#   2. fast-forward the checkout, so the Compose file matches the images;
#   3. pull every image, and stop here, with nothing running touched, if any
#      pull fails;
#   4. start the new images and restart the service, which looks up the engine
#      image's ID when it starts, so it never points at a removed one;
#   5. only then remove the images nothing uses any more.
#
# MELETE_UPDATE_MIN_FREE_GB sets the space required before pulling (default 4).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

compose=(docker compose -f deploy/docker-compose.yml "$@")
min_free_gb="${MELETE_UPDATE_MIN_FREE_GB:-4}"

say() { printf '==> %s\n' "$*"; }
fail() {
  printf 'update: %s\n' "$*" >&2
  exit 1
}

case "$min_free_gb" in
  '' | *[!0-9]*) fail "MELETE_UPDATE_MIN_FREE_GB must be a whole number of gigabytes, not '$min_free_gb'" ;;
esac

command -v docker >/dev/null || fail 'docker is not on PATH'
docker compose version >/dev/null || fail 'the Docker Compose plugin is not installed'
docker info >/dev/null 2>&1 || fail 'cannot reach the Docker engine'

# 1. Free space where Docker keeps its images. A remote or desktop engine keeps
# them on another machine, so it is measured from a container there, with an
# image the installation already has.
docker_root="$(docker info --format '{{.DockerRootDir}}')"
if [ -d "$docker_root" ]; then
  free_kb="$(df -Pk "$docker_root" | awk 'NR == 2 { print $4 }')"
else
  probe="$("${compose[@]}" config --images | grep '^postgres:' | head -n 1)" ||
    fail 'cannot read the Compose file'
  free_kb="$(docker run --rm --network none -v "$docker_root:/docker-root:ro" --entrypoint df "$probe" -Pk /docker-root |
    awk 'NR == 2 { print $4 }')" || fail "cannot measure free space in $docker_root"
fi
case "$free_kb" in
  '' | *[!0-9]*) fail "cannot measure free space in $docker_root" ;;
esac
free_mb=$((free_kb / 1024))
if [ "$free_mb" -lt "$((min_free_gb * 1024))" ]; then
  fail "only ${free_mb} MB free in $docker_root; pulling needs at least ${min_free_gb} GB.
  Nothing was changed. Free space first, for example:
    docker builder prune -af   # build cache from building the images from source
    docker image prune -f      # images no container uses and no tag names
  then run this again. MELETE_UPDATE_MIN_FREE_GB sets the threshold."
fi
say "${free_mb} MB free in $docker_root"

# 2. The checkout. --ff-only refuses a diverged or locally edited tree rather
# than merging into it.
say 'Updating the checkout'
git pull --ff-only || fail 'git pull --ff-only failed; nothing was pulled or restarted'

# Built-from-source names mean MELETE_IMAGE_TAG is unset: there is nothing to pull.
images="$("${compose[@]}" config --images)" || fail 'docker compose config failed'
if printf '%s\n' "$images" | grep -Eq '^melete-[a-z]+:local$'; then
  fail 'MELETE_IMAGE_TAG is not set, so this installation builds its images from source.
  Set MELETE_IMAGE_TAG=main (or a version) in deploy/.env to use the published images,
  or update a source build with: git pull --ff-only && docker compose -f deploy/docker-compose.yml up -d --build --wait'
fi
say 'Images:'
printf '%s\n' "$images" | sort -u | sed 's/^/      /'

# 3. Every image first. A failed pull leaves the running stack exactly as it was.
say 'Pulling'
"${compose[@]}" pull || fail 'a pull failed; the running containers were not touched'

# Spaces given a computer before the switch to published images name
# melete-sandbox:local in their connection. While that image is on this engine,
# it follows the published one, so those computers are updated too.
sandbox="$(printf '%s\n' "$images" | grep -E '/melete-sandbox:[^/]+$' | head -n 1 || true)"
if [ -n "$sandbox" ] && docker image inspect melete-sandbox:local >/dev/null 2>&1; then
  say "Pointing melete-sandbox:local at $sandbox for computers made before the switch"
  docker tag "$sandbox" melete-sandbox:local
fi

# 4. Start what changed, then restart the service: it resolves the engine image
# to an ID when it starts, and a new engine image alone does not recreate it.
say 'Starting the new images'
"${compose[@]}" up -d --no-build --wait --wait-timeout 600 ||
  fail 'the stack did not become healthy; old images were kept. Check: docker compose -f deploy/docker-compose.yml logs --tail=100'
say 'Restarting the service so it uses the new engine image'
"${compose[@]}" restart melete || fail 'restarting the service failed; old images were kept'
"${compose[@]}" up -d --no-build --wait --wait-timeout 600 ||
  fail 'the stack did not become healthy after the restart; old images were kept'

# 5. Last: the images the pull replaced. Anything a container still uses,
# including an attempt that started before the update, is kept.
say 'Removing replaced images'
docker image prune -f

"${compose[@]}" ps
say 'Updated'
