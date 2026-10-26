#!/usr/bin/env bash
#
# Build the Windows installer and publish it as GitHub release v<version>.
#
#   tools/publish.sh "What changed, one or two sentences"
#
# The version comes from package.json; bump it and commit first. Installed
# copies find the release through its latest.yml within 6 h (or at once from
# the toolbar's update button). Releases are full releases, not GitHub
# "pre-releases": the updater and /releases/latest both skip pre-releases.
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
NOTES=${1:-}
VERSION=$(node -p 'require("./package.json").version')
TAG="v$VERSION"
EXE="release/PartitionForge-Setup-$VERSION.exe"

command -v gh >/dev/null || { echo "gh not found" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit first: the release is tagged from HEAD" >&2; exit 1; }
[ -f resources/offline/pfengine.efi ] || { echo "resources/offline/pfengine.efi missing; run offline-engine/build-image.sh" >&2; exit 1; }
if gh release view "$TAG" >/dev/null 2>&1; then echo "$TAG is already released; bump the version" >&2; exit 1; fi

npm run typecheck
npm test
rm -f release/latest.yml release/PartitionForge-Setup-*.exe release/PartitionForge-Setup-*.exe.blockmap
WINEDEBUG=-all npm run dist:win
grep -q "^version: $VERSION\$" release/latest.yml || { echo "latest.yml does not describe $VERSION" >&2; exit 1; }

git push origin HEAD
git tag -a "$TAG" -m "PartitionForge $VERSION" 2>/dev/null || true
git push origin "$TAG"
gh release create "$TAG" --verify-tag --title "PartitionForge $VERSION (beta)" \
  --notes "${NOTES:+$NOTES

}**Beta.** Back up anything you care about before changing partitions. Windows installers are unsigned, so SmartScreen will warn on first run." \
  "$EXE" "$EXE.blockmap" release/latest.yml
