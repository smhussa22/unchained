"""
Inference script for LifelineGNN supply-chain forecasting.

Loads trained weights, runs a 14-day forecast, selects the top-50
hub nodes by degree, assigns supply-chain node types, places them
along the known corridor polyline, and writes forecast.json for
the frontend.
"""

from __future__ import annotations

import heapq
import json
import os
import random
import sys
from collections import Counter, deque

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
try:
    import torch
except ImportError:
    sys.exit("torch is not installed. Run:  pip install torch")

try:
    import torch_geometric  # noqa: F401
except ImportError:
    sys.exit(
        "torch-geometric is not installed. Run:\n"
        "  pip install torch-geometric\n"
        "See https://pytorch-geometric.readthedocs.io/en/latest/install/installation.html"
    )

# ---------------------------------------------------------------------------
# Local imports
# ---------------------------------------------------------------------------
from model import LifelineGNN

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WEIGHTS_PATH = os.path.join(SCRIPT_DIR, "model_weights.pt")
META_PATH = os.path.join(SCRIPT_DIR, "preprocessed_meta.json")
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "..", "frontend", "public")
OUTPUT_PATH = os.path.join(OUTPUT_DIR, "forecast.json")

# ---------------------------------------------------------------------------
# Known node mapping  (model index -> frontend id + GPS)
# ---------------------------------------------------------------------------
KNOWN_NODES = {
    0:  {"id": "manufacturer", "pos": (-66.15, 18.44)},
    1:  {"id": "port-miami",   "pos": (-80.1794, 25.7781)},
    4:  {"id": "dc-us",        "pos": (-83.7205, 33.9926)},
    6:  {"id": "dc-ca",        "pos": (-79.746, 43.5986)},
    24: {"id": "hospital",     "pos": (-81.2737, 43.0096)},
}


def load_meta(path: str) -> dict:
    print(f"[1/5] Loading graph metadata from {path}")
    with open(path, "r") as f:
        meta = json.load(f)
    meta["num_nodes"] = max(max(meta["edge_index"][0]), max(meta["edge_index"][1])) + 1
    return meta


def build_model(device: torch.device) -> LifelineGNN:
    print(f"[2/5] Building LifelineGNN and loading weights from {WEIGHTS_PATH}")
    model = LifelineGNN(
        in_channels=2,
        hidden_dim=128,
        t_future=14,
        num_gcn_layers=2,
        gru_layers=2,
        dropout=0.1,
        num_heads=4,
    )
    state = torch.load(WEIGHTS_PATH, map_location=device, weights_only=True)
    model.load_state_dict(state)
    model.to(device)
    model.eval()
    return model


def run_inference(
    model: LifelineGNN,
    edge_index: torch.Tensor,
    edge_weight: torch.Tensor,
    num_nodes: int,
    device: torch.device,
    normal_inventory: float = 0.95,
) -> torch.Tensor:
    """Return absolute inventory forecasts of shape (num_nodes, 14).

    The model predicts residuals: Δ = Y_future - last_inventory.
    We reconstruct absolute inventory as: clip(last_inventory + Δ, 0, 1).

    Input channels:
      - Channel 0: shock feature (0 = no disruption)
      - Channel 1: observed inventory history (normal_inventory for steady state)
    """
    print(f"[3/5] Running inference (1, {num_nodes}, 14, 2) ...")
    print(f"  -> Normal inventory level: {normal_inventory}")

    # Build input: no shock (ch0=0), steady inventory (ch1=normal_inventory)
    x_seq = torch.zeros(1, num_nodes, 14, 2, device=device)
    x_seq[:, :, :, 1] = normal_inventory  # channel 1 = inventory history

    with torch.no_grad():
        raw = model(x_seq, edge_index, edge_weight)  # (1, 500, 14) residuals

    residuals = raw.squeeze(0)  # (500, 14)

    # Reconstruct absolute inventory: last_inventory + Δ, clamped to [0, 1]
    last_inventory = normal_inventory
    preds = torch.clamp(last_inventory + residuals, 0.0, 1.0)

    print(f"  -> residual range: [{residuals.min().item():.4f}, {residuals.max().item():.4f}]")
    print(f"  -> inventory range: [{preds.min().item():.4f}, {preds.max().item():.4f}]")
    return preds


def compute_cascade_scenarios(
    meta: dict,
    baseline_preds: torch.Tensor,
) -> dict[str, torch.Tensor]:
    """Compute disruption scenarios using graph-theoretic cascade propagation.

    For each severable node, we compute shortest-path distance (weighted by
    inverse edge weight) to every other node in the directed graph. Downstream
    nodes receive a supply degradation that is:
      - Stronger for nodes closer to the disruption source
      - Delayed for nodes further away (onset shifts later in the 14-day window)
      - Scaled by edge weight (stronger connections = faster propagation)

    Upstream nodes (not reachable downstream from the severed node) are unaffected.
    """
    print("[3b/5] Computing graph-theoretic cascade scenarios ...")

    src_list, dst_list = meta["edge_index"][0], meta["edge_index"][1]
    num_nodes = meta["num_nodes"]
    edge_weights = meta["edge_weights_scaled"]

    # Build weighted directed adjacency: node -> [(neighbor, weight), ...]
    adj: dict[int, list[tuple[int, float]]] = {n: [] for n in range(num_nodes)}
    for s, d, w in zip(src_list, dst_list, edge_weights):
        adj[s].append((d, w))

    scenarios: dict[str, torch.Tensor] = {}

    for node_idx, info in KNOWN_NODES.items():
        node_id = info["id"]
        if node_id == "hospital":
            continue

        # Dijkstra from severed node along directed edges
        # Distance = sum of (1 / edge_weight) so stronger edges = shorter distance
        dist = [float("inf")] * num_nodes
        dist[node_idx] = 0.0
        heap: list[tuple[float, int]] = [(0.0, node_idx)]

        while heap:
            d, u = heapq.heappop(heap)
            if d > dist[u]:
                continue
            for v, w in adj[u]:
                cost = d + 1.0 / (w + 0.01)  # inverse weight: strong edge = low cost
                if cost < dist[v]:
                    dist[v] = cost
                    heapq.heappush(heap, (cost, v))

        # Normalize distances for reachable downstream nodes
        reachable = [d for d in dist if d < float("inf") and d > 0]
        if not reachable:
            # No downstream nodes — scenario = baseline
            scenarios[node_id] = baseline_preds.clone()
            print(f"  -> {node_id}: no downstream nodes, using baseline")
            continue

        max_dist = max(reachable)

        # Build scenario predictions: apply degradation to downstream nodes
        scenario = baseline_preds.clone()  # (num_nodes, 14)

        for n in range(num_nodes):
            if dist[n] == float("inf") or dist[n] == 0:
                continue  # upstream or the severed node itself

            norm_dist = dist[n] / max_dist  # 0 = closest downstream, 1 = farthest

            # Degradation strength: closer nodes lose more supply
            # severity: 0.85 for closest, 0.15 for farthest
            severity = 0.85 * (1.0 - norm_dist * 0.8)

            # Onset delay: closer nodes feel it sooner
            # onset: day 0 for closest, day 8 for farthest
            onset_day = norm_dist * 8.0

            # Daily consumption rate: hospital uses ~8% of remaining stock per day
            # when supply is cut off (no replenishment)
            daily_consumption = 0.06 + severity * 0.06  # 6-12% per day based on severity

            remaining = scenario[n, 0].item()
            for day in range(14):
                if day < onset_day:
                    scenario[n, day] = remaining
                    continue

                # Ramp up: disruption cuts off more supply over 3 days
                days_since = day - onset_day
                ramp = min(1.0, days_since / 3.0)

                # Supply cut = fraction of normal replenishment lost
                supply_cut = severity * ramp

                # Each day: consume stock, receive reduced replenishment
                # Normal: consume ~8%, replenish ~8% → steady state
                # Disrupted: consume ~8%, replenish only (1-supply_cut)*8% → net drain
                net_drain = daily_consumption * supply_cut
                remaining = max(0.02, remaining - net_drain)
                scenario[n, day] = remaining

        # The severed node itself is offline — rapid collapse
        remaining = scenario[node_idx, 0].item()
        for day in range(14):
            remaining = max(0.02, remaining * 0.5)  # loses 50% per day
            scenario[node_idx, day] = remaining

        scenarios[node_id] = scenario

        # Stats for reachable downstream nodes
        affected = sum(1 for d in dist if 0 < d < float("inf"))
        hospital_idx = next(idx for idx, info in KNOWN_NODES.items() if info["id"] == "hospital")
        hospital_val = scenario[hospital_idx, -1].item()
        print(f"  -> {node_id}: {affected} downstream nodes affected, hospital day-14: {hospital_val:.3f}")

    return scenarios


# Geographic bounding boxes per node type (lng_min, lng_max, lat_min, lat_max)
# These place nodes on plausible land geography along the supply corridor.
TYPE_REGIONS: dict[str, tuple[float, float, float, float]] = {
    "manufacturer": (-67.0, -65.8, 18.0, 18.5),     # Puerto Rico island (tighter)
    "port":         (-82.0, -80.5, 26.5, 30.5),     # Florida inland — well west of Atlantic coast
    "distribution": (-85.5, -80.0, 34.0, 40.0),     # Atlanta → WV/PA (inland)
    "hospital":     (-81.0, -79.5, 42.8, 44.0),     # Southern Ontario / Great Lakes shore
}


def generate_network(meta: dict, preds: "torch.Tensor", scenarios: dict[str, "torch.Tensor"] | None = None) -> dict:
    """Select top-50 hub nodes and build a network with typed nodes and edges."""
    print("[4/5] Generating top-50 hub network ...")

    src_list, dst_list = meta["edge_index"][0], meta["edge_index"][1]
    num_nodes = meta["num_nodes"]

    # --- (a) Select top 50 nodes by total degree ---
    out_deg: Counter = Counter(src_list)
    in_deg: Counter = Counter(dst_list)
    total_deg = {n: out_deg.get(n, 0) + in_deg.get(n, 0) for n in range(num_nodes)}
    top_nodes = sorted(total_deg, key=lambda n: total_deg[n], reverse=True)[:50]
    top_set = set(top_nodes)

    # --- (b) Edges between top 50 ---
    internal_edges = [
        (s, d) for s, d in zip(src_list, dst_list) if s in top_set and d in top_set
    ]

    # --- (c) Assign node types based on topology ---
    KNOWN_TYPES = {0: "manufacturer", 1: "port", 4: "distribution", 6: "distribution", 24: "hospital"}

    # We need BFS depth before assigning types, so compute it first
    # --- (d) BFS depth from source nodes ---
    # Build adjacency for BFS (full graph, not just top-50)
    adj: dict[int, list[int]] = {n: [] for n in range(num_nodes)}
    for s, d in zip(src_list, dst_list):
        adj[s].append(d)

    sources = [n for n in range(num_nodes) if in_deg.get(n, 0) == 0]
    depth = [-1] * num_nodes
    queue: deque[int] = deque()
    for s in sources:
        if depth[s] == -1:
            depth[s] = 0
            queue.append(s)
    while queue:
        node = queue.popleft()
        for nb in adj[node]:
            if depth[nb] == -1:
                depth[nb] = depth[node] + 1
                queue.append(nb)
    # Nodes unreachable from sources get max depth
    max_depth = max((d for d in depth if d >= 0), default=1)
    for i in range(num_nodes):
        if depth[i] == -1:
            depth[i] = max_depth

    # --- Assign node types using absolute BFS depth ---
    def _node_type(n: int) -> str:
        if n in KNOWN_TYPES:
            return KNOWN_TYPES[n]
        d = depth[n]
        if d == 0:
            return "manufacturer"
        if d == 1:
            return "port"
        if d == 2:
            return "distribution"
        return "hospital"  # depth 3+

    # --- (e) Place nodes in geographic regions by type ---
    known_positions = {idx: info["pos"] for idx, info in KNOWN_NODES.items()}

    preds_list = preds.cpu().tolist()

    # Pre-convert scenario tensors to lists for indexing
    scenario_lists: dict[str, list] = {}
    if scenarios:
        for scenario_id, scenario_preds in scenarios.items():
            scenario_lists[scenario_id] = scenario_preds.cpu().tolist()

    network_nodes = []
    node_index_to_network = {}  # model index -> network list index
    for rank, n in enumerate(top_nodes):
        if n in known_positions:
            lng, lat = known_positions[n]
        else:
            ntype = _node_type(n)
            lng_min, lng_max, lat_min, lat_max = TYPE_REGIONS[ntype]
            rng = random.Random(n)  # deterministic per node
            lng = rng.uniform(lng_min, lng_max)
            lat = rng.uniform(lat_min, lat_max)

        node_index_to_network[n] = rank

        node_entry: dict = {
            "position": [round(lng, 4), round(lat, 4)],
            "type": _node_type(n),
            "forecasts": [round(v, 4) for v in preds_list[n]],
        }

        if scenario_lists:
            scenario_forecasts: dict[str, list[float]] = {}
            for scenario_id, sp_list in scenario_lists.items():
                scenario_forecasts[scenario_id] = [round(v, 4) for v in sp_list[n]]
            node_entry["scenarioForecasts"] = scenario_forecasts

        network_nodes.append(node_entry)

    # --- (e) Build network edges ---
    network_edges = []
    for s, d in internal_edges:
        si = node_index_to_network[s]
        di = node_index_to_network[d]
        network_edges.append({
            "sourcePosition": network_nodes[si]["position"],
            "targetPosition": network_nodes[di]["position"],
        })

    # --- Stats ---
    type_dist: Counter = Counter(nd["type"] for nd in network_nodes)
    print(f"  -> {len(network_nodes)} nodes, {len(network_edges)} edges")
    print(f"  -> type distribution: {dict(type_dist)}")

    return {"networkNodes": network_nodes, "networkEdges": network_edges}


def build_output(preds: "torch.Tensor", network: dict, scenarios: dict[str, "torch.Tensor"] | None = None) -> dict:
    """Assemble the forecast.json structure."""
    print("[5/5] Building forecast.json ...")

    preds_list = preds.cpu().tolist()

    # Pre-convert scenario tensors to lists for indexing
    scenario_lists: dict[str, list] = {}
    if scenarios:
        for scenario_id, scenario_preds in scenarios.items():
            scenario_lists[scenario_id] = scenario_preds.cpu().tolist()

    # Named chain forecasts for the 5 key nodes
    chain_forecasts: dict = {}
    for idx, info in KNOWN_NODES.items():
        baseline = [round(v, 4) for v in preds_list[idx]]
        if scenario_lists:
            node_scenarios: dict[str, list[float]] = {}
            for scenario_id, sp_list in scenario_lists.items():
                node_scenarios[scenario_id] = [round(v, 4) for v in sp_list[idx]]
            chain_forecasts[info["id"]] = {
                "baseline": baseline,
                "scenarios": node_scenarios,
            }
        else:
            chain_forecasts[info["id"]] = baseline

    return {
        "chainForecasts": chain_forecasts,
        "networkNodes": network["networkNodes"],
        "networkEdges": network["networkEdges"],
    }


def main():
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}\n")

    # 1. Load metadata
    meta = load_meta(META_PATH)

    # 2. Build model
    model = build_model(device)

    # 3. Prepare graph tensors
    edge_index = torch.tensor(meta["edge_index"], dtype=torch.long, device=device)
    edge_weight = torch.tensor(meta["edge_weights_scaled"], dtype=torch.float32, device=device)

    # 4. Inference
    num_nodes = meta["num_nodes"]
    preds = run_inference(model, edge_index, edge_weight, num_nodes, device)

    # 4b. Graph-theoretic cascade scenarios
    scenarios = compute_cascade_scenarios(meta, preds)

    # 5. Generate network
    network = generate_network(meta, preds, scenarios)

    # 6. Assemble and write output
    output = build_output(preds, network, scenarios)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, separators=(",", ":"))

    size_kb = os.path.getsize(OUTPUT_PATH) / 1024
    print(f"\nWrote {OUTPUT_PATH} ({size_kb:.1f} KB)")
    print(f"  chainForecasts: {list(output['chainForecasts'].keys())}")
    print(f"  networkNodes:   {len(output['networkNodes'])} entries")
    print(f"  networkEdges:   {len(output['networkEdges'])} entries")
    print("Done.")


if __name__ == "__main__":
    main()
