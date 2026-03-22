"""
Evaluation metrics for the Lifeline supply-chain model: regression,
physics-imbalance diagnostics, OOD ratio, shortage classification and lead-time,
per-role RMSE, optional mass-balance and Dirichlet energy, bootstrap CIs,
threshold calibration, Brier score, episode detection, and false-alert rate.
"""

import numpy as np


def rmse(y_true, y_pred):
    return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))


def mae(y_true, y_pred):
    return float(np.mean(np.abs(y_true - y_pred)))


def physics_imbalance_score(y_pred, edges, edge_weights, threshold=0.5):
    """Mean weighted downstream increase when upstream is below threshold."""
    violations = []
    for i, edge in enumerate(edges):
        u, v = edge["source"], edge["target"]
        d = edge["transit_days"]
        w = edge_weights[i]

        for t in range(y_pred.shape[2] - 1):
            t_down = min(t + d, y_pred.shape[2] - 1)
            upstream_crashed = y_pred[:, u, t] < threshold
            if not upstream_crashed.any():
                continue
            downstream_gain = np.maximum(
                0, y_pred[:, v, t_down] - y_pred[:, v, max(0, t_down - 1)]
            )
            violations.append(
                float((w * downstream_gain[upstream_crashed]).mean())
            )
    return float(np.mean(violations)) if violations else 0.0


def ood_degradation_ratio(in_dist_rmse, ood_rmse, max_acceptable=1.5):
    """OOD RMSE divided by in-distribution RMSE; values near one imply modest degradation."""
    if in_dist_rmse == 0:
        return float("inf")
    return ood_rmse / in_dist_rmse


def shortage_classification(y_true, y_pred, threshold=0.5):
    """Precision, recall, F1 at fixed inventory threshold (per node-time step)."""
    true_short = y_true < threshold
    pred_short = y_pred < threshold

    tp = int((true_short & pred_short).sum())
    fp = int((~true_short & pred_short).sum())
    fn = int((true_short & ~pred_short).sum())
    tn = int((~true_short & ~pred_short).sum())

    precision = tp / max(tp + fp, 1)
    recall = tp / max(tp + fn, 1)
    f1 = 2 * precision * recall / max(precision + recall, 1e-8)

    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "actual_shortages": int(true_short.sum()),
        "predicted_shortages": int(pred_short.sum()),
    }


def shortage_lead_time(y_true, y_pred, threshold=0.5):
    """Days between first predicted and first actual below-threshold crossing (window-by-node)."""
    W, N, T = y_true.shape
    leads = []

    for w in range(W):
        for n in range(N):
            actual_below = np.where(y_true[w, n] < threshold)[0]
            if len(actual_below) == 0:
                continue
            first_actual = actual_below[0]

            pred_below = np.where(y_pred[w, n] < threshold)[0]
            if len(pred_below) == 0:
                leads.append(-first_actual)
                continue
            leads.append(first_actual - pred_below[0])

    if not leads:
        return {
            "mean_days": 0.0, "median_days": 0.0, "count": 0,
            "early_pct": 0.0, "ontime_pct": 0.0, "late_pct": 0.0,
        }

    arr = np.array(leads)
    return {
        "mean_days": round(float(arr.mean()), 2),
        "median_days": round(float(np.median(arr)), 2),
        "count": len(leads),
        "early_pct": round(float((arr > 0).mean() * 100), 1),
        "ontime_pct": round(float((arr == 0).mean() * 100), 1),
        "late_pct": round(float((arr < 0).mean() * 100), 1),
    }


def per_role_rmse(y_true, y_pred, node_roles):
    """RMSE broken down by node role (manufacturer / hub / hospital)."""
    role_ids = {}
    for nid, role in node_roles.items():
        role_ids.setdefault(role, []).append(nid)

    results = {}
    for role, nids in sorted(role_ids.items()):
        role_true = y_true[:, nids, :]
        role_pred = y_pred[:, nids, :]
        results[role] = round(float(np.sqrt(np.mean((role_true - role_pred) ** 2))), 6)
    return results


def holdout_mass_balance_check(y_pred, edges, edge_weights, node_roles,
                               threshold=0.5, tolerance=0.1):
    """Aggregate edge-weighted imbalance of per-step inventory changes (diagnostic).

    Parameters
    ----------
    y_pred : ndarray, shape (W, N, T)
    edges : list of dict with keys source, target
    edge_weights : ndarray, shape (E,)
    node_roles : dict
        Reserved for API symmetry; unused in the current computation.
    threshold : float
        Unused; reserved for future masking.
    tolerance : float
        Per-step absolute imbalance below which a step counts as conserved.

    Returns
    -------
    dict
        mean_imbalance, max_imbalance, fraction_conserved, n_timesteps.
    """
    W, N, T = y_pred.shape
    n_steps = T - 1
    if n_steps <= 0 or len(edges) == 0:
        return {
            "mean_imbalance": 0.0,
            "max_imbalance": 0.0,
            "fraction_conserved": 1.0,
            "n_timesteps": 0,
        }

    # inventory change per node between consecutive time steps: (W, N, T-1)
    delta = y_pred[:, :, 1:] - y_pred[:, :, :-1]

    # For each edge (u, v) with weight w, the net weighted change is
    # w * (delta_u + delta_v).  Summing over all edges gives the aggregate
    # "mass flow imbalance" per window per time step.
    imbalance = np.zeros((W, n_steps))
    for i, edge in enumerate(edges):
        u, v = edge["source"], edge["target"]
        w = edge_weights[i]
        imbalance += w * (delta[:, u, :] + delta[:, v, :])

    # Average over windows → one imbalance value per time step
    step_imbalance = np.abs(imbalance).mean(axis=0)

    return {
        "mean_imbalance": round(float(step_imbalance.mean()), 6),
        "max_imbalance": round(float(step_imbalance.max()), 6),
        "fraction_conserved": round(
            float((step_imbalance < tolerance).mean()), 6
        ),
        "n_timesteps": int(n_steps),
    }


def per_scenario_holdout_check(y_pred_list, edges, edge_weights, node_roles,
                               threshold=0.5, tolerance=0.1):
    """Run holdout_mass_balance_check on each scenario and aggregate.

    Parameters
    ----------
    y_pred_list : list[np.ndarray]
        One predicted-inventory array per scenario, each shape (W, N, T).
    edges, edge_weights, node_roles, threshold, tolerance :
        Forwarded to :func:`holdout_mass_balance_check`.

    Returns
    -------
    dict
        ``per_scenario`` – list of per-scenario result dicts.
        ``aggregate``    – dict with ``mean_imbalance_mean`` and
                           ``mean_imbalance_std`` across scenarios.
    """
    per_scenario = [
        holdout_mass_balance_check(
            yp, edges, edge_weights, node_roles,
            threshold=threshold, tolerance=tolerance,
        )
        for yp in y_pred_list
    ]

    mean_imbalances = np.array([s["mean_imbalance"] for s in per_scenario])
    return {
        "per_scenario": per_scenario,
        "aggregate": {
            "mean_imbalance_mean": round(float(mean_imbalances.mean()), 6),
            "mean_imbalance_std": round(float(mean_imbalances.std()), 6),
        },
    }


def dirichlet_energy(node_embeddings, edge_index):
    """Mean squared embedding difference across edges (graph signal smoothness)."""
    sources = edge_index[0]
    targets = edge_index[1]
    num_edges = len(sources)
    if num_edges == 0:
        return 0.0

    src_emb = node_embeddings[sources]
    tgt_emb = node_embeddings[targets]
    diff = src_emb - tgt_emb
    energy = float(np.sum(diff ** 2)) / num_edges
    return energy


def bootstrap_ci(y_true, y_pred, metric_fn, n_bootstrap=1000, ci=95, seed=42):
    """Bootstrap CI for ``metric_fn`` with resampling along the scenario axis (W)."""
    rng = np.random.RandomState(seed)
    point_estimate = float(metric_fn(y_true, y_pred))

    n_scenarios = y_true.shape[0]
    boot_values = []
    for _ in range(n_bootstrap):
        idx = rng.randint(0, n_scenarios, size=n_scenarios)
        boot_values.append(float(metric_fn(y_true[idx], y_pred[idx])))

    boot_values = np.array(boot_values)
    lower = (100 - ci) / 2
    upper = 100 - lower

    return {
        "point_estimate": round(point_estimate, 6),
        "ci_lower": round(float(np.percentile(boot_values, lower)), 6),
        "ci_upper": round(float(np.percentile(boot_values, upper)), 6),
        "ci_level": ci,
        "std": round(float(np.std(boot_values)), 6),
    }


def calibrate_threshold(y_true, y_pred, thresholds=None, metric="f1"):
    """Grid search over thresholds; maximise ``metric`` in {f1, precision, recall}."""
    if thresholds is None:
        thresholds = np.arange(0.3, 0.8, 0.05).tolist()

    all_scores = []
    best_threshold = thresholds[0]
    best_score = -1.0

    for thr in thresholds:
        result = shortage_classification(y_true, y_pred, threshold=thr)
        score = result[metric]
        all_scores.append({
            "threshold": round(float(thr), 4),
            "f1": result["f1"],
            "precision": result["precision"],
            "recall": result["recall"],
        })
        if score > best_score:
            best_score = score
            best_threshold = thr

    return {
        "best_threshold": round(float(best_threshold), 4),
        "best_score": round(float(best_score), 4),
        "all_scores": all_scores,
    }


def brier_score(y_true, y_pred, threshold=0.5):
    """Brier score using a proxy probability clip((threshold - y_pred) / threshold) vs I(y_true < threshold)."""
    actual = (y_true < threshold).astype(np.float64)
    prob = np.clip((threshold - y_pred) / threshold, 0.0, 1.0)
    return float(np.mean((prob - actual) ** 2))


def episode_detection_rate(y_true, y_pred, threshold=0.5, min_lead_days=1):
    """Share of below-threshold episodes with a predicted crossing at least min_lead_days before onset."""
    W, N, T = y_true.shape
    total_episodes = 0
    detected = 0

    for w in range(W):
        for n in range(N):
            actual = y_true[w, n] < threshold
            if not actual.any():
                continue

            # Find episode starts (transitions from normal to shortage)
            starts = []
            if actual[0]:
                starts.append(0)
            for t in range(1, T):
                if actual[t] and not actual[t - 1]:
                    starts.append(t)

            for start in starts:
                total_episodes += 1
                required = start - min_lead_days
                if required < 0:
                    # Not enough horizon to have advance warning
                    continue
                pred_below = y_pred[w, n, :start] < threshold
                if pred_below.any():
                    first_pred = int(np.where(pred_below)[0][0])
                    if first_pred <= required:
                        detected += 1

    rate = detected / max(total_episodes, 1)
    return {
        "detection_rate": round(rate, 4),
        "episodes_detected": detected,
        "total_episodes": total_episodes,
    }


def false_alert_rate(y_true, y_pred, threshold=0.5):
    """Rate of predicted shortage when truth is above threshold (aggregated over node-time)."""
    W, N, T = y_true.shape
    false_alerts = int(((y_true >= threshold) & (y_pred < threshold)).sum())
    total_node_windows = W * N
    rate = false_alerts / max(total_node_windows, 1)
    return {
        "rate_per_node_per_window": round(rate, 4),
        "total_false_alerts": false_alerts,
        "total_node_windows": total_node_windows,
    }
