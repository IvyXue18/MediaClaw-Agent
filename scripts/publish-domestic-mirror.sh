#!/bin/sh
# Publish the domestic mirror on media.mediaclaw.app that launchers and install prompts use when GitHub is unreachable.
#
#   scripts/publish-domestic-mirror.sh runtime v0.4.1 [dir]
#     Copies a published GitHub Release's runtime files to agent/runtime/<tag>/.
#     [dir] may already hold the downloaded release files; otherwise gh downloads them.
#   scripts/publish-domestic-mirror.sh package origin/main
#     Archives the given commit (run it on the commit just pushed to main) to
#     agent/package/v<version>/MediaClaw-Agent.zip plus a .sha256 file.
#
# Requires MEDIACLAW_MIRROR_BUCKET (the R2 bucket behind media.mediaclaw.app), a wrangler login with access to it,
# curl and shasum; runtime mode without [dir] also needs gh.

set -eu

MODE="${1:?usage: publish-domestic-mirror.sh runtime <tag> [dir] | package <git-ref>}"
REPOSITORY="IvyXue18/MediaClaw-Agent"
BUCKET="${MEDIACLAW_MIRROR_BUCKET:?set MEDIACLAW_MIRROR_BUCKET to the R2 bucket behind media.mediaclaw.app}"
PUBLIC_ORIGIN="https://media.mediaclaw.app"
WRANGLER="${WRANGLER:-wrangler}"
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

put_object() {
  key="$1"
  file="$2"
  type="$3"
  cache="$4"
  echo "Uploading $key" >&2
  $WRANGLER r2 object put "$BUCKET/$key" --remote --file "$file" \
    --content-type "$type" --cache-control "$cache" >/dev/null
}

public_sha256() {
  curl --fail --location --silent --show-error "$PUBLIC_ORIGIN/$1" | shasum -a 256 | awk '{print $1}'
}

publish_runtime() {
  tag="${1:?runtime mode needs a tag such as v0.4.1}"
  source_dir="${2:-}"
  case "$tag" in
    v[0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "Tag must look like v0.4.1: $tag" >&2; exit 1 ;;
  esac
  prefix="agent/runtime/$tag"
  if [ -z "$source_dir" ]; then
    source_dir="$(mktemp -d)"
    trap 'rm -rf "$source_dir"' EXIT HUP INT TERM
    gh release download "$tag" --repo "$REPOSITORY" --dir "$source_dir" \
      --pattern 'mediaclaw-agent-*' --pattern checksums.txt --pattern runtime-manifest.json
  fi
  cd "$source_dir"
  test -s checksums.txt || { echo "checksums.txt is missing in $source_dir" >&2; exit 1; }
  shasum -a 256 -c checksums.txt

  # Binaries are immutable per tag; the lists stay short-lived so a corrected upload shows up quickly.
  for file in $(awk '{name=$2; sub(/^\*/, "", name); print name}' checksums.txt); do
    test -f "$file" || { echo "Release file is missing: $file" >&2; exit 1; }
    put_object "$prefix/$file" "$file" application/octet-stream "public, max-age=31536000, immutable"
  done
  put_object "$prefix/checksums.txt" checksums.txt "text/plain; charset=utf-8" "public, max-age=300"
  if [ -f runtime-manifest.json ]; then
    put_object "$prefix/runtime-manifest.json" runtime-manifest.json application/json "public, max-age=300"
  fi

  status=0
  while read -r expected name; do
    name="${name#\*}"
    actual="$(public_sha256 "$prefix/$name")"
    if [ "$actual" = "$expected" ]; then
      echo "verified $PUBLIC_ORIGIN/$prefix/$name"
    else
      echo "MISMATCH $PUBLIC_ORIGIN/$prefix/$name (got $actual, expected $expected)" >&2
      status=1
    fi
  done < checksums.txt
  curl --fail --silent --show-error "$PUBLIC_ORIGIN/$prefix/checksums.txt" | cmp -s - checksums.txt || {
    echo "MISMATCH $PUBLIC_ORIGIN/$prefix/checksums.txt" >&2
    status=1
  }
  exit "$status"
}

publish_package() {
  ref="${1:?package mode needs a git ref such as origin/main}"
  cd "$REPO_ROOT"
  commit="$(git rev-parse --verify "$ref^{commit}")"
  version="$(git show "$commit:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
  prompt_version="$(git show "$commit:plugins/mediaclaw/contracts/install-prompts.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).agentVersion))')"
  test "$version" = "$prompt_version" || {
    echo "package.json $version does not match install prompts $prompt_version at $commit" >&2
    exit 1
  }
  prefix="agent/package/v$version"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT HUP INT TERM
  git archive --format=zip --prefix=MediaClaw-Agent/ --output "$work/MediaClaw-Agent.zip" "$commit"
  (cd "$work" && shasum -a 256 MediaClaw-Agent.zip > MediaClaw-Agent.zip.sha256)
  expected="$(awk '{print $1}' "$work/MediaClaw-Agent.zip.sha256")"

  # The same version may be re-archived after a launcher or prompt fix, so nothing here is cached for long.
  put_object "$prefix/MediaClaw-Agent.zip" "$work/MediaClaw-Agent.zip" application/zip "public, max-age=300"
  put_object "$prefix/MediaClaw-Agent.zip.sha256" "$work/MediaClaw-Agent.zip.sha256" "text/plain; charset=utf-8" "public, max-age=300"

  actual="$(public_sha256 "$prefix/MediaClaw-Agent.zip")"
  published="$(curl --fail --silent --show-error "$PUBLIC_ORIGIN/$prefix/MediaClaw-Agent.zip.sha256" | awk '{print $1}')"
  if [ "$actual" != "$expected" ] || [ "$published" != "$expected" ]; then
    echo "MISMATCH $PUBLIC_ORIGIN/$prefix/MediaClaw-Agent.zip (zip $actual, sha256 file $published, expected $expected)" >&2
    exit 1
  fi
  echo "verified $PUBLIC_ORIGIN/$prefix/MediaClaw-Agent.zip ($commit, sha256 $expected)"
}

case "$MODE" in
  runtime) shift; publish_runtime "$@" ;;
  package) shift; publish_package "$@" ;;
  *) echo "Unknown mode: $MODE (expected runtime or package)" >&2; exit 1 ;;
esac
