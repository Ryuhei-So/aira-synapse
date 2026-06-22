#!/usr/bin/env python3
"""
Entity Deduplication — Bulk In-Memory Optimization.

Directly reads/writes the .agdb JSON file to merge duplicate entities
(those differing only by leading "the ").

Usage: python3 scripts/bulk-entity-dedup.py [--dry-run]
"""

import json
import sys
import os
from copy import deepcopy

DRY_RUN = '--dry-run' in sys.argv
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'benchmark', 'hotpotqa', 'hotpotqa.agdb')

print(f"Entity Deduplication (Bulk){' [DRY RUN]' if DRY_RUN else ''}")
print(f"  Loading {DB_PATH}...")

with open(DB_PATH, 'r') as f:
    data = json.load(f)

nodes = data['nodes']
edges = data['edges']
print(f"  Nodes: {len(nodes)}, Edges: {len(edges)}")

# --- Identify entity nodes ---
entity_nodes = {}  # nodeId -> key in nodes dict
for key, node in nodes.items():
    if node.get('layer') == 'entity':
        nid = node.get('nodeId', '')
        entity_nodes[nid] = key

print(f"  Entity nodes: {len(entity_nodes)}")

# --- Build merge map: "the_X" -> "X" ---
merge_map = {}  # duplicate nodeId -> canonical nodeId
canonical_set = set()

entity_names = set(entity_nodes.keys())
for nid in entity_names:
    raw = nid.replace('entity:', '')
    if raw.startswith('the_'):
        canonical_raw = raw[4:]  # strip "the_"
        canonical_nid = f"entity:{canonical_raw}"
        # Only merge if canonical exists AND canonical name is ≥ 2 words or ≥ 6 chars
        if canonical_nid in entity_names:
            word_count = len(canonical_raw.split('_'))
            if word_count >= 2 or len(canonical_raw) >= 6:
                merge_map[nid] = canonical_nid
                canonical_set.add(canonical_nid)

print(f"  Merge pairs: {len(merge_map)}")
if DRY_RUN:
    for dup, canon in list(merge_map.items())[:20]:
        print(f"    {dup} -> {canon}")
    print("  [DRY RUN] No changes applied.")
    sys.exit(0)

# --- Execute merges ---
print("  Redirecting edges...")
redirected = 0
removed_edges = set()

new_edges = {}
for edge_key, edge in edges.items():
    src = edge.get('sourceNodeId', '')
    tgt = edge.get('targetNodeId', '')
    new_src = merge_map.get(src, src)
    new_tgt = merge_map.get(tgt, tgt)
    
    if new_src != src or new_tgt != tgt:
        # Skip self-loops
        if new_src == new_tgt:
            removed_edges.add(edge_key)
            continue
        # Create redirected edge
        new_edge = dict(edge)
        new_edge['sourceNodeId'] = new_src
        new_edge['targetNodeId'] = new_tgt
        # Generate new edge ID
        new_id = edge_key
        if src in merge_map:
            old_part = src.replace('entity:', '')
            new_part = new_src.replace('entity:', '')
            new_id = new_id.replace(old_part, new_part, 1)
        if tgt in merge_map:
            old_part = tgt.replace('entity:', '')
            new_part = new_tgt.replace('entity:', '')
            new_id = new_id.replace(old_part, new_part, 1)
        new_edge['edgeId'] = new_id
        new_edges[new_id] = new_edge
        removed_edges.add(edge_key)
        redirected += 1

# Apply edge changes
for key in removed_edges:
    del edges[key]
edges.update(new_edges)

# --- Delete duplicate nodes ---
deleted = 0
for dup_nid in merge_map:
    node_key = entity_nodes.get(dup_nid)
    if node_key and node_key in nodes:
        del nodes[node_key]
        deleted += 1

print(f"  Redirected edges: {redirected}")
print(f"  Removed self-loop edges: {len(removed_edges) - redirected}")
print(f"  Deleted duplicate nodes: {deleted}")
print(f"  Final: Nodes={len(nodes)}, Edges={len(edges)}")

# --- Write back ---
print("  Writing optimized database...")
with open(DB_PATH, 'w') as f:
    json.dump(data, f, separators=(',', ':'))

final_size = os.path.getsize(DB_PATH)
print(f"  File size: {final_size / 1024 / 1024:.1f} MB")
print("  Done.")
