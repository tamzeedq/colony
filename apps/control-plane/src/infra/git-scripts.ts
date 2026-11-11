// Fixed shell scripts run inside the git container with `sh -c <script> colony <args...>`.
// User input only ever arrives as positional parameters ("$1", "$2"), never interpolated into
// the script text, so there is no shell injection surface. Keep these LF and POSIX sh.

export const REPO = '/srv/git/repo.git'

export const PROTECTED_MESSAGE = 'main is protected: Colony merges after human approval'

export const PRE_RECEIVE_HOOK = `#!/bin/sh
# Installed by Colony. Agents push their own branches; main only moves via an approved merge
# performed locally in this container (local commits do not run this hook).
status=0
while read -r old new ref; do
  if [ "$ref" = "refs/heads/main" ]; then
    echo "${PROTECTED_MESSAGE}" >&2
    status=1
  fi
done
exit $status
`

/** $1 = repoUrl ('' for a fresh repo), $2 = project name, $3 = hook body. Idempotent. */
export const ENSURE_REPO = `set -eu
R=${REPO}
if [ ! -f "$R/HEAD" ]; then
  rm -rf "$R.tmp"
  if [ -n "$1" ]; then
    git clone --quiet --bare -- "$1" "$R.tmp"
    # Colony's model is a protected main. If the remote's default branch is something else
    # (e.g. master), create main at the remote HEAD and make it the default.
    if ! git -C "$R.tmp" show-ref --verify --quiet refs/heads/main; then
      git -C "$R.tmp" branch main HEAD
    fi
    git -C "$R.tmp" symbolic-ref HEAD refs/heads/main
  else
    git init --quiet --bare -b main "$R.tmp"
    T=$(mktemp -d)
    git -C "$T" init --quiet -b main
    printf '# %s\\n' "$2" > "$T/README.md"
    git -C "$T" add README.md
    git -C "$T" -c user.name=Colony -c user.email=colony@colony.local commit --quiet -m "Initial commit"
    git -C "$T" push --quiet "$R.tmp" main
    rm -rf "$T"
  fi
  mv "$R.tmp" "$R"
fi
printf '%s' "$3" > "$R/hooks/pre-receive.new"
chmod 0755 "$R/hooks/pre-receive.new"
mv "$R/hooks/pre-receive.new" "$R/hooks/pre-receive"
`

/** Prints `<branch> <sha> <behind> <ahead>` per local branch. */
export const LIST_BRANCHES = `set -eu
cd ${REPO}
hasmain=0
git show-ref --verify --quiet refs/heads/main && hasmain=1
git for-each-ref --format='%(refname:strip=2) %(objectname)' refs/heads | while read -r n s; do
  if [ "$hasmain" = 1 ]; then
    c=$(git rev-list --left-right --count "refs/heads/main...refs/heads/$n")
  else
    c="0 0"
  fi
  echo "$n $s $c"
done
`

/** $1 = branch. Unified diff main...branch (changes on the branch since the merge base). */
export const DIFF = `set -eu
cd ${REPO}
git rev-parse --verify --quiet "refs/heads/$1^{commit}" >/dev/null || { echo "no such branch: $1" >&2; exit 3; }
exec git diff --no-color "refs/heads/main...refs/heads/$1" --
`

/** Exit codes for MERGE. */
export const MERGE_EXIT = { noBranch: 3, worktree: 4, refMoved: 5, failed: 6, conflict: 10, upToDate: 11 } as const

/** $1 = branch, $2 = message. Merges in a throwaway detached worktree, then moves main with a
 *  compare-and-swap update-ref (fails if main moved meanwhile). Prints the new main sha. */
export const MERGE = `set -u
R=${REPO}
cd "$R"
git rev-parse --verify --quiet "refs/heads/$1^{commit}" >/dev/null || { echo "no such branch: $1" >&2; exit 3; }
OLD=$(git rev-parse --verify refs/heads/main) || { echo "main does not exist" >&2; exit 6; }
T=$(mktemp -d)
cleanup() { git -C "$R" worktree remove --force "$T/wt" >/dev/null 2>&1; rm -rf "$T"; git -C "$R" worktree prune; }
trap cleanup EXIT
git worktree add --quiet --detach "$T/wt" "$OLD" >&2 || exit 4
cd "$T/wt"
if ! git -c user.name=Colony -c user.email=colony@colony.local merge --no-ff --no-edit -m "$2" "refs/heads/$1" >&2; then
  if [ -n "$(git ls-files -u)" ]; then
    git diff --name-only --diff-filter=U >&2
    git merge --abort >/dev/null 2>&1
    exit 10
  fi
  git merge --abort >/dev/null 2>&1
  exit 6
fi
NEW=$(git rev-parse HEAD)
if [ "$NEW" = "$OLD" ]; then echo "$OLD"; exit 11; fi
git -C "$R" update-ref -m "colony: merge $1" refs/heads/main "$NEW" "$OLD" >&2 || exit 5
echo "$NEW"
`

/** Exit codes for PUSH_REMOTE. */
export const PUSH_EXIT = { noRef: 3, failed: 6, rejected: 10 } as const

/** $1 = remote URL, $2 = local ref, $3 = remote branch. The token arrives as $COLONY_GIT_TOKEN
 *  in the exec environment; the auth header is built here and handed to git through
 *  GIT_CONFIG_COUNT/KEY/VALUE (environment only: not in argv, not in any config file).
 *  Never --force. Prints the pushed sha on stdout; git's output goes to stderr. */
export const PUSH_REMOTE = `set -u
cd ${REPO}
SHA=$(git rev-parse --verify --quiet "$2^{commit}") || { echo "no such ref: $2" >&2; exit 3; }
H=$(printf 'x-access-token:%s' "\${COLONY_GIT_TOKEN:-}" | base64 | tr -d '\\n')
unset COLONY_GIT_TOKEN
export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Basic $H"
export GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1=
OUT=$(git push --porcelain -- "$1" "$SHA:refs/heads/$3" 2>&1)
rc=$?
printf '%s\\n' "$OUT" >&2
if [ $rc -ne 0 ]; then
  case "$OUT" in
    *non-fast-forward*|*"fetch first"*|*"[rejected]"*) exit 10 ;;
  esac
  exit 6
fi
echo "$SHA"
`
