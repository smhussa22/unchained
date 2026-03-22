"""
Physics-informed loss: shortage-weighted prediction term plus smooth gated
flow penalty on the directed graph.

The flow term uses a sigmoid gate on upstream inventory (temperature-scaled),
optional lag alignment via edge transit times, and normalisation comparable in
scale to the MSE term. When predictions are residuals, pass the last-observed
inventory baseline so conservation is evaluated on reconstructed absolute levels.
"""

import torch
import torch.nn.functional as F


def shortage_weighted_mse_loss(
    y_pred,
    y_true,
    *,
    baseline=None,
    shortage_threshold=0.6,
    shortage_weight_alpha=0.0,
):
    """Heteroscedastic-style weighting: larger weight when true absolute inventory is low."""
    if shortage_weight_alpha <= 0:
        return F.mse_loss(y_pred, y_true)

    abs_true = y_true + baseline if baseline is not None else y_true
    severity = torch.relu(shortage_threshold - abs_true) / shortage_threshold
    weights = 1.0 + shortage_weight_alpha * severity
    return ((y_pred - y_true) ** 2 * weights).mean()


def smooth_physics_flow_loss(
    y_pred,
    edge_index,
    edge_weight,
    threshold=0.80,
    temperature=0.1,
    transit_days=None,
    baseline=None,
):
    """
    Penalise downstream inventory increases when upstream is stressed.

    Reconstructs absolute inventory from residuals if ``baseline`` is given.
    If ``transit_days`` is provided, source and target are compared at times
    offset by each edge's delay.
    """
    y_abs = y_pred + baseline if baseline is not None else y_pred

    if transit_days is None:
        src_inv = y_abs[:, edge_index[0], :]
        tgt_inv = y_abs[:, edge_index[1], :]

        gate = torch.sigmoid((threshold - src_inv) / temperature)
        violation = F.relu(tgt_inv - src_inv) * gate
        weighted = violation * edge_weight[None, :, None]

        n_elements = max(weighted.numel(), 1)
        return weighted.sum() / n_elements

    T = y_abs.shape[2]
    total_violation = torch.tensor(0.0, device=y_abs.device)
    n_elements = 0

    for lag in transit_days.unique():
        lag_int = int(lag.item())
        if lag_int >= T:
            continue

        mask = transit_days == lag
        ei_src = edge_index[0, mask]
        ei_tgt = edge_index[1, mask]
        ew_sub = edge_weight[mask]

        src_inv = y_abs[:, ei_src, :T - lag_int]
        tgt_inv = y_abs[:, ei_tgt, lag_int:]

        gate = torch.sigmoid((threshold - src_inv) / temperature)
        violation = F.relu(tgt_inv - src_inv) * gate
        weighted = violation * ew_sub[None, :, None]

        total_violation = total_violation + weighted.sum()
        n_elements += weighted.numel()

    return total_violation / max(n_elements, 1)


def combined_loss(
    y_pred,
    y_true,
    edge_index,
    edge_weight,
    lambda_flow=0.1,
    threshold=0.80,
    temperature=0.1,
    transit_days=None,
    baseline=None,
    shortage_threshold=0.6,
    shortage_weight_alpha=0.0,
):
    """Return total loss and a dict of scalar components for logging."""
    loss_pred = shortage_weighted_mse_loss(
        y_pred,
        y_true,
        baseline=baseline,
        shortage_threshold=shortage_threshold,
        shortage_weight_alpha=shortage_weight_alpha,
    )
    loss_flow = smooth_physics_flow_loss(
        y_pred,
        edge_index,
        edge_weight,
        threshold=threshold,
        temperature=temperature,
        transit_days=transit_days,
        baseline=baseline,
    )
    total = loss_pred + lambda_flow * loss_flow
    return total, {
        "mse": loss_pred.item(),
        "flow": loss_flow.item(),
        "total": total.item(),
    }


def lambda_schedule(epoch, lambda_max=0.1, warmup_epochs=5, total_epochs=30):
    """Linear ramp of physics weight from zero to lambda_max over warmup_epochs."""
    if epoch < warmup_epochs:
        return lambda_max * (epoch / warmup_epochs)
    return lambda_max
