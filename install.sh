#!/bin/sh
# Install jira-local from its GitHub releases: no Homebrew, no Deno.
#
#   curl -fsSL https://raw.githubusercontent.com/jollytoad/jira-local/main/install.sh | sh
#
# Needs curl, tar and a sha256 tool (sha256sum or shasum).
set -eu

repo="jollytoad/jira-local"
name="jira-local"
prefix="${JIRA_LOCAL_PREFIX:-$HOME/.local/bin}"
tag=""

usage() {
  cat <<USAGE
Install $name into a directory on your PATH.

  --prefix <dir>    Where to put the binary (default: $prefix)
  --version <ver>   Release to install, e.g. 0.2.0 or v0.2.0 (default: latest)
  -h, --help        Show this help
USAGE
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      [ $# -gt 1 ] || die "--prefix needs a directory"
      prefix="$2"
      shift 2
      ;;
    --prefix=*)
      prefix="${1#*=}"
      shift
      ;;
    --version)
      [ $# -gt 1 ] || die "--version needs a version"
      tag="$2"
      shift 2
      ;;
    --version=*)
      tag="${1#*=}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) die "$(uname -s) is not supported — build from source or use Homebrew" ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch="aarch64" ;;
  x86_64 | amd64) arch="x86_64" ;;
  *) die "$(uname -m) is not supported — build from source or use Homebrew" ;;
esac

case "$os-$arch" in
  darwin-aarch64) target="aarch64-apple-darwin" ;;
  darwin-x86_64) target="x86_64-apple-darwin" ;;
  linux-aarch64) target="aarch64-unknown-linux-gnu" ;;
  linux-x86_64) target="x86_64-unknown-linux-gnu" ;;
esac

# Release tags carry a v, a bare version does not.
case "$tag" in
  "") ;;
  v*) ;;
  *) tag="v$tag" ;;
esac

if [ -z "$tag" ]; then
  # The permalink for the latest release redirects to its tag, which sidesteps
  # the GitHub api and its anonymous rate limit.
  latest="$(curl -fsSL -o /dev/null -w '%{url_effective}' \
    "https://github.com/$repo/releases/latest")"
  case "$latest" in
    */tag/v*) tag="${latest##*/tag/}" ;;
    *) die "could not resolve the latest release (got $latest)" ;;
  esac
fi

asset="$name-$tag-$target.tar.gz"
checksums="$name-$tag-checksums.txt"
base="https://github.com/$repo/releases/download/$tag"

tmp="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '$tmp'" EXIT

printf 'Downloading %s %s (%s)\n' "$name" "$tag" "$target"
curl -fsSL -o "$tmp/$asset" "$base/$asset" || die "could not download $asset"

sha=""
if curl -fsSL -o "$tmp/$checksums" "$base/$checksums" 2>/dev/null; then
  sha="$(awk -v asset="$asset" '$2 == asset || $2 == "*" asset { print $1 }' \
    "$tmp/$checksums")"
  [ -n "$sha" ] || die "no checksum for $asset in $checksums"
fi

if [ -n "$sha" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"
  else
    actual=""
    printf 'warning: no sha256 tool found, skipping the checksum check\n' >&2
  fi
  [ -z "$actual" ] || [ "$actual" = "$sha" ] ||
    die "checksum mismatch for $asset (expected $sha, got $actual)"
  [ -z "$actual" ] || printf 'Checksum verified\n'
else
  printf 'warning: %s unavailable, skipping the checksum check\n' "$checksums" >&2
fi

tar -xzf "$tmp/$asset" -C "$tmp" "$name" || die "could not unpack $asset"

mkdir -p "$prefix" || die "could not create $prefix"
mv "$tmp/$name" "$prefix/$name.new" || die "could not write to $prefix"
chmod +x "$prefix/$name.new"
mv "$prefix/$name.new" "$prefix/$name" || die "could not replace $prefix/$name"

printf '\nInstalled %s %s to %s\n' "$name" "$tag" "$prefix/$name"

case ":$PATH:" in
  *":$prefix:"*) ;;
  *)
    printf '\n%s is not on your PATH. Add this to your shell profile:\n' "$prefix"
    printf '  export PATH="%s:$PATH"\n' "$prefix"
    ;;
esac

case ":$PATH:" in
  *":$prefix/$name:"*) ;;
  *)
    shadow="$(command -v "$name" 2>/dev/null || true)"
    [ -z "$shadow" ] || printf '\nwarning: %s from %s also shadows this install.\n' \
      "$name" "$shadow"
    ;;
esac

printf '\nNext: %s init\n' "$name"