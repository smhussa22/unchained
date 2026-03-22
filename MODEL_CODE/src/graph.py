"""
Graph topology construction for the Lifeline supply-chain network.

Builds a Barabási–Albert scale-free graph with role-based tiers
(manufacturer → transit_hub → hospital) and directed downstream edges.
"""

import random
from collections import deque

import networkx as nx
import numpy as np

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
NUM_NODES = 500
BA_M = 2

MFG_REGIONS = [
    {"name": "Puerto Rico", "lon": (-67.0, -65.0), "lat": (18.0, 18.5)},
    {"name": "India", "lon": (72.0, 85.0), "lat": (15.0, 25.0)},
    {"name": "Ireland", "lon": (-9.0, -6.0), "lat": (52.0, 54.0)},
]
HUB_REGIONS = [
    {"name": "US East Coast", "lon": (-80.0, -70.0), "lat": (25.0, 40.0)},
    {"name": "US West Coast", "lon": (-122.0, -117.0), "lat": (33.0, 48.0)},
    {"name": "Western Europe", "lon": (0.0, 10.0), "lat": (45.0, 55.0)},
]
HARDCODED = {
    498: ([-81.2745, 43.0118], "University Hospital, London ON"),
    499: ([-79.3832, 43.6532], "Toronto General Hospital"),
}

ROLE_TIER = {"manufacturer": 0, "transit_hub": 1, "hospital": 2}


def _assign_coordinates(role, nid):
    if nid in HARDCODED:
        return HARDCODED[nid][0]
    if role == "manufacturer":
        r = random.choice(MFG_REGIONS)
    elif role == "transit_hub":
        r = random.choice(HUB_REGIONS)
    else:
        return [random.uniform(-125.0, -70.0), random.uniform(30.0, 50.0)]
    return [random.uniform(*r["lon"]), random.uniform(*r["lat"])]


def build_graph(num_nodes=NUM_NODES, ba_m=BA_M, seed=42):
    """Return nodes, edges, adjacency dict, manufacturer IDs, and node roles."""
    G = nx.barabasi_albert_graph(n=num_nodes, m=ba_m, seed=seed)
    degrees = dict(G.degree())
    sorted_nodes = sorted(degrees, key=degrees.get, reverse=True)

    node_roles = {}
    nodes = []
    manufacturer_ids = []

    for rank, nid in enumerate(sorted_nodes):
        if rank < int(num_nodes * 0.02):
            role = "manufacturer"
        elif rank < int(num_nodes * 0.10):
            role = "transit_hub"
        else:
            role = "hospital"

        coords = _assign_coordinates(role, nid)
        nodes.append(
            {
                "node_id": nid,
                "type": role,
                "coordinates": [round(coords[0], 4), round(coords[1], 4)],
            }
        )
        node_roles[nid] = role
        if role == "manufacturer":
            manufacturer_ids.append(nid)

    edges = []
    for u, v in G.edges():
        u_tier = ROLE_TIER[node_roles[u]]
        v_tier = ROLE_TIER[node_roles[v]]
        if u_tier < v_tier:
            s, t = u, v
        elif u_tier > v_tier:
            s, t = v, u
        else:
            s, t = (u, v) if degrees[u] >= degrees[v] else (v, u)
        edges.append(
            {
                "source": s,
                "target": t,
                "baseline_volume": degrees[s] * degrees[t] * 100,
                "transit_days": random.randint(1, 10),
            }
        )

    edge_index = [[e["source"] for e in edges], [e["target"] for e in edges]]

    adjacency = {}
    for e in edges:
        adjacency.setdefault(e["source"], []).append(
            (e["target"], e["transit_days"])
        )

    return nodes, edges, edge_index, adjacency, manufacturer_ids, node_roles


def scale_edge_weights(edges):
    """Min-Max normalise edge baseline volumes to [0, 1]."""
    raw = np.array([e["baseline_volume"] for e in edges], dtype=np.float32)
    w_min, w_max = raw.min(), raw.max()
    if w_max - w_min == 0:
        return np.ones_like(raw)
    return (raw - w_min) / (w_max - w_min)


def compute_bfs_distances(adjacency, manufacturer_ids, num_nodes):
    """Minimum hop count from any manufacturer to each node; per-target edge list."""
    node_distances = {}

    for mfg in manufacturer_ids:
        visited = {mfg: 0}
        queue = deque([mfg])
        while queue:
            current = queue.popleft()
            for neighbour, _transit in adjacency.get(current, []):
                if neighbour not in visited:
                    visited[neighbour] = visited[current] + 1
                    queue.append(neighbour)
        for node, dist in visited.items():
            if node not in node_distances or dist < node_distances[node]:
                node_distances[node] = dist

    for nid in range(num_nodes):
        if nid not in node_distances:
            node_distances[nid] = num_nodes

    edge_distances = []
    for src in sorted(adjacency):
        for tgt, _transit in adjacency[src]:
            edge_distances.append(node_distances[tgt])

    return {"node_distances": node_distances, "edge_distances": edge_distances}
