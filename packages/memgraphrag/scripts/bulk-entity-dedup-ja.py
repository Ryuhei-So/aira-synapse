#!/usr/bin/env python3
"""
JA Entity Deduplication — Merge duplicate entity nodes in Japanese agdb.

Patterns:
1. "the_X" → "X" (English articles)
2. Katakana normalization (ヴィ→ビ, ティ→チ, etc.)
3. Long vowel/gemination removal (ー, ッ) for matching

Usage: python3 scripts/bulk-entity-dedup-ja.py [--dry-run]
"""

import json
import sys
import os
import re
from copy import deepcopy

DRY_RUN = '--dry-run' in sys.argv
DB_PATH = os.environ.get('DB_PATH',
    os.path.join(os.path.dirname(__file__), '..', 'data', 'benchmark', 'hotpotqa-ja', 'hotpotqa-ja.agdb'))

print(f"JA Entity Deduplication{' [DRY RUN]' if DRY_RUN else ''}")
print(f"  Loading {DB_PATH}...")

with open(DB_PATH, 'r') as f:
    data = json.load(f)

nodes = data['nodes']
edges = data['edges']
print(f"  Nodes: {len(nodes)}, Edges: {len(edges)}")

# --- Identify entity nodes ---
entity_nodes = {}
for key, node in nodes.items():
    if node.get('layer') == 'entity':
        nid = node.get('nodeId', '')
        entity_nodes[nid] = key

print(f"  Entity nodes: {len(entity_nodes)}")

# --- Katakana normalization ---
KATA_VARIANTS = [
    ('ヴァ', 'バ'), ('ヴィ', 'ビ'), ('ヴェ', 'ベ'), ('ヴォ', 'ボ'), ('ヴ', 'ブ'),
    ('ティ', 'チ'), ('ディ', 'ジ'), ('デュ', 'ジュ'),
    ('ファ', 'ハ'), ('フィ', 'ヒ'), ('フェ', 'ヘ'), ('フォ', 'ホ'),
    ('ウィ', 'ウイ'), ('ウェ', 'ウエ'), ('ウォ', 'ウオ'),
]

def normalize_entity_name(name):
    """Normalize entity name for matching."""
    n = name.lower().strip()
    # Strip "the_" prefix
    if n.startswith('the_'):
        n = n[4:]
    # Katakana normalization
    for old, new in KATA_VARIANTS:
        n = n.replace(old, new)
    # Remove long vowel marks and geminate consonants
    n = n.replace('ー', '').replace('ッ', '')
    # Normalize underscores/spaces
    n = re.sub(r'[_\s]+', '_', n)
    return n

# --- Build merge map ---
merge_map = {}  # duplicate nodeId -> canonical nodeId
# Group by normalized name
name_groups = {}
for nid in entity_nodes:
    raw = nid.replace('entity:', '')
    norm = normalize_entity_name(raw)
    if norm not in name_groups:
        name_groups[norm] = []
    name_groups[norm].append(nid)

# For groups with multiple entries, pick canonical (shortest name = most common)
for norm, nids in name_groups.items():
    if len(nids) <= 1:
        continue
    # Sort by name length (shorter = canonical), then alphabetically
    nids_sorted = sorted(nids, key=lambda x: (len(x), x))
    canonical = nids_sorted[0]
    for dup in nids_sorted[1:]:
        # Safety: only merge if both are ≥ 2 chars after entity: prefix
        dup_name = dup.replace('entity:', '')
        if len(dup_name) >= 2:
            merge_map[dup] = canonical

# Also handle "the_X" → "X" for English-like entities
entity_names_set = set(entity_nodes.keys())
for nid in list(entity_names_set):
    raw = nid.replace('entity:', '')
    if raw.startswith('the_'):
        canonical_raw = raw[4:]
        canonical_nid = f"entity:{canonical_raw}"
        if canonical_nid in entity_names_set and nid not in merge_map:
            word_count = len(canonical_raw.split('_'))
            if word_count >= 2 or len(canonical_raw) >= 6:
                merge_map[nid] = canonical_nid

print(f"  Merge pairs: {len(merge_map)}")

if DRY_RUN:
    for dup, canon in list(merge_map.items())[:30]:
        print(f"    {dup} -> {canon}")
    print(f"  [DRY RUN] Would merge {len(merge_map)} pairs. No changes applied.")
    sys.exit(0)

if len(merge_map) == 0:
    print("  No duplicates found. Done.")
    sys.exit(0)

# --- Apply merges ---
# 1. Redirect edges
redirected = 0
self_loops_removed = 0
new_edges = {}

for edge_key, edge in edges.items():
    src = edge.get('source', '')
    tgt = edge.get('target', '')
    new_src = merge_map.get(src, src)
    new_tgt = merge_map.get(tgt, tgt)

    if new_src == new_tgt and src != tgt:
        self_loops_removed += 1
        continue

    if new_src != src or new_tgt != tgt:
        redirected += 1
        edge = deepcopy(edge)
        edge['source'] = new_src
        edge['target'] = new_tgt

    new_edges[edge_key] = edge

data['edges'] = new_edges

# 2. Remove duplicate nodes
removed = 0
for dup_nid in merge_map:
    key = entity_nodes.get(dup_nid)
    if key and key in nodes:
        del nodes[key]
        removed += 1

print(f"  Edges redirected: {redirected}")
print(f"  Self-loops removed: {self_loops_removed}")
print(f"  Nodes removed: {removed}")
print(f"  Final: Nodes={len(nodes)}, Edges={len(data['edges'])}")

# --- Save ---
backup_path = DB_PATH + '.pre-dedup-ja.bak'
os.rename(DB_PATH, backup_path)
print(f"  Backup: {backup_path}")

with open(DB_PATH, 'w') as f:
    json.dump(data, f, ensure_ascii=False)
print(f"  Saved: {DB_PATH}")
print("  Done.")
