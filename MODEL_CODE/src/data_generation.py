"""
Synthetic supply-chain dynamics: Barabási–Albert shock propagation on a
directed adjacency list with randomised severity, per-hop attenuation,
shortage duration, recovery curves, demand noise, optional secondary shocks,
lead-time jitter, and a separate OOD generator that draws parameters outside
the training ranges for generalisation tests.
"""

import math
import random
from collections import deque

import numpy as np

RECOVERY_CURVES = ["linear", "exponential", "logarithmic", "sqrt"]


def _recovery_fraction(d, duration, curve="linear"):
    """Recovery progress in [0, 1] for day d of a shortage of length duration."""
    t = d / duration
    if curve == "exponential":
        return 1.0 - math.exp(-5.0 * t)
    if curve == "logarithmic":
        return math.log1p(d) / math.log1p(duration)
    if curve == "sqrt":
        return math.sqrt(t)
    # default: linear
    return t

NUM_DAYS = 365
NORMAL_LEVEL = 0.90
NOISE_STD = 0.03
FLOOR = 0.15
DEFAULT_NUM_SAMPLES = 100

SEVERITY_RANGE = (0.6, 1.0)
ATTENUATION_RANGE = (0.65, 0.90)
DURATION_RANGE = (10, 18)


def propagate_shock(
    inventory_matrix,
    start_node,
    start_day,
    severity,
    adjacency,
    attenuation=0.80,
    shortage_duration=14,
    floor=FLOOR,
    normal=NORMAL_LEVEL,
    max_lead_time_jitter=1,
    recovery_curve=None,
):
    """Breadth-first shock cascade with stochastic lead-time jitter.

    Parameters
    ----------
    max_lead_time_jitter : int
        Uniform jitter in days added to each edge delay (±).
    recovery_curve : str | None
        One of linear, exponential, logarithmic, sqrt; if None, sampled
        per shock.
    """
    if recovery_curve is None:
        recovery_curve = random.choice(RECOVERY_CURVES)

    queue = deque([(start_node, start_day, severity)])
    visited = set()

    while queue:
        node, day, sev = queue.popleft()
        if (node, day) in visited or sev < 0.05:
            continue
        visited.add((node, day))

        for d in range(shortage_duration):
            t = day + d
            if t >= inventory_matrix.shape[1]:
                break
            recovery = _recovery_fraction(d, shortage_duration, recovery_curve)
            target_level = normal - sev * (normal - floor) * (1 - recovery)
            inventory_matrix[node, t] = np.clip(
                np.random.normal(loc=target_level, scale=NOISE_STD), 0, 1
            )

        for tgt, delay in adjacency.get(node, []):
            jitter = np.random.randint(-max_lead_time_jitter, max_lead_time_jitter + 1)
            arrival = day + max(1, delay + jitter)
            if arrival < inventory_matrix.shape[1]:
                queue.append((tgt, arrival, sev * attenuation))


def _apply_demand_variability(inventory, node_roles, scale=0.04):
    """Role-scaled Gaussian noise on daily inventory (hospitals highest)."""
    for nid, role in node_roles.items():
        if role == "hospital":
            noise = np.random.normal(0, scale, size=inventory.shape[1])
        elif role == "transit_hub":
            noise = np.random.normal(0, scale * 0.5, size=inventory.shape[1])
        else:
            noise = np.random.normal(0, scale * 0.25, size=inventory.shape[1])
        inventory[nid, :] = np.clip(inventory[nid, :] + noise, 0, 1)


def generate_scenarios(
    num_nodes,
    num_days,
    manufacturer_ids,
    adjacency,
    node_roles,
    num_samples=DEFAULT_NUM_SAMPLES,
    multi_shock_prob=0.20,
    demand_variability=True,
):
    """Sample scenarios; each dict includes id, shock metadata, features, targets."""
    all_samples = []

    for sample_idx in range(num_samples):
        inventory = np.zeros((num_nodes, num_days), dtype=np.float32)
        shock = np.zeros((num_nodes, num_days), dtype=np.float32)

        for i in range(num_nodes):
            inventory[i, :] = np.clip(
                np.random.normal(loc=NORMAL_LEVEL, scale=0.02, size=num_days),
                0,
                1,
            ).astype(np.float32)

        shock_node = random.choice(manufacturer_ids)
        max_shock_day = max(21, num_days - DURATION_RANGE[1])
        shock_day = np.random.randint(20, max_shock_day)
        severity = np.random.uniform(*SEVERITY_RANGE)
        attenuation = np.random.uniform(*ATTENUATION_RANGE)
        duration = np.random.randint(*DURATION_RANGE)

        shock[shock_node, shock_day] = 1.0

        propagate_shock(
            inventory,
            start_node=shock_node,
            start_day=shock_day,
            severity=severity,
            adjacency=adjacency,
            attenuation=attenuation,
            shortage_duration=duration,
        )

        if random.random() < multi_shock_prob:
            other_nodes = [m for m in manufacturer_ids if m != shock_node]
            if other_nodes:
                s2_node = random.choice(other_nodes)
                s2_day = np.random.randint(20, max_shock_day)
                s2_sev = np.random.uniform(*SEVERITY_RANGE)
                s2_att = np.random.uniform(*ATTENUATION_RANGE)
                s2_dur = np.random.randint(*DURATION_RANGE)
                shock[s2_node, s2_day] = 1.0
                propagate_shock(
                    inventory,
                    start_node=s2_node,
                    start_day=s2_day,
                    severity=s2_sev,
                    adjacency=adjacency,
                    attenuation=s2_att,
                    shortage_duration=s2_dur,
                )

        if demand_variability:
            _apply_demand_variability(inventory, node_roles)

        all_samples.append(
            {
                "scenario_id": sample_idx,
                "shock_node": shock_node,
                "shock_day": shock_day,
                "features": shock,
                "targets": inventory,
                "severity": severity,
                "attenuation": attenuation,
            }
        )

    return all_samples


def generate_ood_scenarios(
    num_nodes,
    num_days,
    manufacturer_ids,
    adjacency,
    node_roles,
    num_samples=15,
):
    """Scenarios with severity and attenuation outside ``SEVERITY_RANGE`` / ``ATTENUATION_RANGE``."""
    all_samples = []
    for idx in range(num_samples):
        inventory = np.zeros((num_nodes, num_days), dtype=np.float32)
        shock = np.zeros((num_nodes, num_days), dtype=np.float32)

        for i in range(num_nodes):
            inventory[i, :] = np.clip(
                np.random.normal(loc=NORMAL_LEVEL, scale=0.02, size=num_days),
                0,
                1,
            ).astype(np.float32)

        shock_node = random.choice(manufacturer_ids)
        max_shock_day = max(21, num_days - 22)
        shock_day = np.random.randint(20, max_shock_day)

        severity = np.random.uniform(0.3, 0.55)
        attenuation = np.random.uniform(0.50, 0.64)
        duration = np.random.randint(8, 22)

        shock[shock_node, shock_day] = 1.0
        propagate_shock(
            inventory,
            start_node=shock_node,
            start_day=shock_day,
            severity=severity,
            adjacency=adjacency,
            attenuation=attenuation,
            shortage_duration=duration,
        )

        _apply_demand_variability(inventory, node_roles)

        all_samples.append(
            {
                "scenario_id": idx,
                "shock_node": shock_node,
                "shock_day": shock_day,
                "features": shock,
                "targets": inventory,
                "severity": severity,
                "attenuation": attenuation,
            }
        )

    return all_samples


T_PAST = 14
T_FUTURE = 14
STRIDE = 7


def create_windows(sample, t_past=T_PAST, t_future=T_FUTURE, stride=STRIDE):
    """Slide across one scenario and return (X_shock, X_inv, Y) triples."""
    shock = sample["features"]
    inv = sample["targets"]
    num_days = shock.shape[1]

    xs, xi, ys = [], [], []
    for t in range(t_past, num_days - t_future, stride):
        xs.append(shock[:, t - t_past : t])
        xi.append(inv[:, t - t_past : t])
        ys.append(inv[:, t : t + t_future])

    return (
        np.array(xs, dtype=np.float32),
        np.array(xi, dtype=np.float32),
        np.array(ys, dtype=np.float32),
    )


def create_stratified_windows(sample, t_past=T_PAST, t_future=T_FUTURE, stride=STRIDE):
    """Slide across one scenario and return windows tagged by shock phase.

    Labels: pre_shock (shock after window), during_shock (shock in lookback),
    post_shock (shock before window). Returns stratified stacks plus ``all`` and
    per-window ``labels``.
    """
    shock = sample["features"]
    inv = sample["targets"]
    num_nodes = shock.shape[0]
    num_days = shock.shape[1]
    shock_day = sample["shock_day"]

    buckets = {"pre_shock": ([], [], []),
               "during_shock": ([], [], []),
               "post_shock": ([], [], [])}
    all_xs, all_xi, all_ys = [], [], []
    labels = []

    for t in range(t_past, num_days - t_future, stride):
        window_start = t - t_past
        window_end = t

        x_s = shock[:, window_start:window_end]
        x_i = inv[:, window_start:window_end]
        y = inv[:, t:t + t_future]

        all_xs.append(x_s)
        all_xi.append(x_i)
        all_ys.append(y)

        if shock_day >= window_end:
            tag = "pre_shock"
        elif shock_day >= window_start:
            tag = "during_shock"
        else:
            tag = "post_shock"

        labels.append(tag)
        buckets[tag][0].append(x_s)
        buckets[tag][1].append(x_i)
        buckets[tag][2].append(y)

    def _stack(triplet):
        if len(triplet[0]) == 0:
            return (
                np.empty((0, num_nodes, t_past), dtype=np.float32),
                np.empty((0, num_nodes, t_past), dtype=np.float32),
                np.empty((0, num_nodes, t_future), dtype=np.float32),
            )
        return (
            np.array(triplet[0], dtype=np.float32),
            np.array(triplet[1], dtype=np.float32),
            np.array(triplet[2], dtype=np.float32),
        )

    result = {k: _stack(v) for k, v in buckets.items()}
    result["all"] = (
        np.array(all_xs, dtype=np.float32),
        np.array(all_xi, dtype=np.float32),
        np.array(all_ys, dtype=np.float32),
    )
    result["labels"] = labels
    return result
