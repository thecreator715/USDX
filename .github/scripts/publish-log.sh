#!/usr/bin/env bash
# Publishes the scrubbed keeper log to the keeper-log branch (read by the app). Usage: publish-log.sh <run.log>
set +e
LOG="$1"; URL="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
if [ ! -d /tmp/kl/.git ]; then
  rm -rf /tmp/kl; git clone -q --depth 1 -b keeper-log "$URL" /tmp/kl 2>/dev/null || { mkdir -p /tmp/kl && cd /tmp/kl && git init -q -b keeper-log; }
fi
cd /tmp/kl && git config user.name github-actions && git config user.email actions@users.noreply.github.com
touch last-run.log
# keep earlier runs, replace this run's section with the current log
grep -v "^--- run $GITHUB_RUN_ID " last-run.log > base.log 2>/dev/null
awk -v id="$GITHUB_RUN_ID" 'BEGIN{skip=0} /^--- run /{ if ($3==id) skip=1; else skip=0 } { if(!skip) print }' last-run.log > base.log
{ cat base.log; echo "--- run $GITHUB_RUN_ID $(date -u +%FT%TZ) ---"; grep -v '^    at ' "$LOG" | sed -E 's/s[A-Za-z0-9]{24,}/[hidden]/g' | cut -c1-400; } | tail -n 900 > next.log
mv next.log last-run.log; rm -f base.log
git add -A && git commit -qm "keeper log $GITHUB_RUN_ID" && git push -qf "$URL" keeper-log
