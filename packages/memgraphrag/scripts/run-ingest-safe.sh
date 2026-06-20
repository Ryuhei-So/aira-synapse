#!/bin/bash
# WAL-safe runner for batch ingest.
# Runs ingest in 50-doc batches, removing WAL files between runs
# to work around LadybugDB v0.17.1 WAL assertion bug.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../../data/benchmark/hotpotqa-ja"
DB_PATH="$DATA_DIR/hotpotqa-ja.lbug"

echo "=== WAL-safe batch ingest runner ==="
echo "DB: $DB_PATH"
echo ""

ITERATION=0
while true; do
  ITERATION=$((ITERATION + 1))
  
  # Remove WAL files before each run
  rm -f "$DB_PATH.wal" "$DB_PATH.wal.checkpoint"
  
  echo "--- Iteration $ITERATION (WAL cleaned) ---"
  
  # Run ingest - it will exit(0) after 50 docs or when complete
  set +e
  node "$SCRIPT_DIR/batch-index-ja.mjs" ingest 2>&1
  EXIT_CODE=$?
  set -e
  
  if [ $EXIT_CODE -ne 0 ]; then
    echo ""
    echo "ERROR: ingest failed with exit code $EXIT_CODE"
    echo "Cleaning WAL and retrying..."
    rm -f "$DB_PATH.wal" "$DB_PATH.wal.checkpoint"
    sleep 2
    continue
  fi
  
  # Check if the output contains "Ingest complete" (meaning all docs done + embeddings)
  # If exit code 0 but no "Ingest complete", it's a checkpoint exit (more docs to process)
  # We check by looking at processed_docs.json vs total docs
  PROCESSED=$(node -e "
    const fs = require('fs');
    const p = '$DATA_DIR/batch/processed_docs.json';
    if (fs.existsSync(p)) {
      const d = JSON.parse(fs.readFileSync(p));
      process.stdout.write(String(d.length));
    } else {
      process.stdout.write('0');
    }
  ")
  
  echo "  Processed so far: $PROCESSED / 854"
  
  if [ "$PROCESSED" -ge 854 ]; then
    echo ""
    echo "=== All documents processed! Starting embedding phase... ==="
    # One final run for embeddings (no more checkpoint exits since all docs are done)
    rm -f "$DB_PATH.wal" "$DB_PATH.wal.checkpoint"
    node "$SCRIPT_DIR/batch-index-ja.mjs" ingest 2>&1
    echo ""
    echo "=== DONE ==="
    break
  fi
  
  echo ""
  sleep 1
done
