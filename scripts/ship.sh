#!/bin/sh
# Commit on a branch and push it for a pull request, only if every check passes.
#
#   sh scripts/ship.sh <message-file> <paths...>
#
# Typecheck, lint, tests with the coverage ratchet, build and size budgets
# run first; nothing is committed unless all pass. Never commits to main:
# from main it starts a branch named after the message's first line, and on
# a branch it adds the commit there (one pull request, one or more
# one-concern commits). The floor guard then reads the commit's trailers;
# if it objects, the commit stays local (fix it with `git commit --amend`)
# and nothing is pushed. The pull request is opened and merged on GitHub,
# once CI passes (docs/DEVELOPMENT.md). Logs go to .local/ship/, never to
# the terminal through a pipe, so a failure can't be hidden.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root" || exit 2
[ -f "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null && nvm use 24 >/dev/null
msg="$1"; shift
logs="$root/.local/ship"; mkdir -p "$logs"

# The checks run on the whole working tree but only the listed paths are
# committed: anything else changed would be tested and then left out, so a
# commit could pass here and fail on its own. Commit it too, or stash it.
listed() { # file, paths...: is the file one of the paths, or inside one?
  f="$1"; shift
  for p in "$@"; do
    case "$p" in .|./) return 0 ;; esac  # ".", as in git: everything
    case "$f" in
      "$p"|"${p%/}"/*) return 0 ;;
    esac
  done
  return 1
}
outside=$(git status --porcelain --untracked-files=all | cut -c4- | sed 's/.* -> //' | while IFS= read -r f; do
  listed "$f" "$@" || printf '  %s\n' "$f"
done)
if [ -n "$outside" ]; then
  echo "SHIP: these changes aren't in the listed paths, so the checks wouldn't match the commit. List them, or stash them (git stash push -- <paths>):"
  echo "$outside"
  exit 1
fi

step() { # name, command...
  name="$1"; shift
  if ! "$@" >"$logs/$name.log" 2>&1; then echo "SHIP: $name failed; nothing committed. See .local/ship/$name.log"; tail -15 "$logs/$name.log"; exit 1; fi
}
step typecheck npm run typecheck
step lint npm run lint
step test npm run test:coverage
step build npm run build
step size npm run check:size
echo "SHIP: checks passed ($(grep -E 'Tests ' "$logs/test.log" | tr -s ' ' | tr '\n' ';'))"

# main changes only through pull requests: start a branch for this one.
branch=$(git symbolic-ref --short HEAD) || { echo "SHIP: not on a branch (detached HEAD); switch to one first."; exit 1; }
if [ "$branch" = main ]; then
  git fetch -q origin main || { echo "SHIP: couldn't reach GitHub to check main is current; nothing committed."; exit 1; }
  if [ -n "$(git rev-list main..origin/main)" ]; then
    echo "SHIP: main is behind GitHub (a pull request was merged since). Run: git pull --ff-only, then ship again. Nothing committed."
    exit 1
  fi
  slug=$(head -n 1 "$msg" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//' | cut -c1-48 | sed -E 's/-+$//')
  branch="change/$(date +%Y%m%d)-$slug"
  git switch -q -c "$branch" || { echo "SHIP: couldn't start branch $branch; nothing committed."; exit 1; }
fi

git add -- "$@" || exit 1
git commit -q -F "$msg" || { echo "SHIP: commit failed"; exit 1; }
if ! node scripts/floor-guard.mjs >"$logs/floor-guard.log" 2>&1; then
  echo "SHIP: the floor guard objected; the commit is local only (on $branch), nothing pushed."
  cat "$logs/floor-guard.log"
  exit 1
fi
git push -q -u origin "$branch" || { echo "SHIP: push failed; the commit is local, on $branch."; exit 1; }
repo=$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')
echo "SHIP: pushed $(git log --oneline -1) to $branch"
echo "SHIP: open or update the pull request: https://github.com/$repo/compare/main...$branch?expand=1"
