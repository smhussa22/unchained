"""Load ``data/model_weights.pt``, rebuild data with fixed seeds, then report
shortage and operational metrics, OOD scenarios, and fairly trained ablations.
Training kwargs must match ``train_gpu.py`` (see ``FAIR_TRAIN_KWARGS``).
Writes ``data/eval_results.json``.
"""
import json
import random
import time

import numpy as np
import torch
from torch.utils.data import DataLoader, TensorDataset

from src.graph import build_graph, scale_edge_weights
from src.data_generation import (
    generate_scenarios, generate_ood_scenarios, create_windows,
    T_PAST, T_FUTURE, STRIDE,
)
from src.evaluation import (
    rmse, mae, physics_imbalance_score, ood_degradation_ratio,
    shortage_classification, shortage_lead_time, per_role_rmse,
    calibrate_threshold, brier_score, episode_detection_rate,
    false_alert_rate,
)
from src.model import LifelineGNN, TemporalOnlyGRU, SpatialOnlyGNN, MLPBaseline
from src.training import train, make_input

FAIR_TRAIN_KWARGS = {
    "epochs": 100,
    "lr": 3e-3,
    "batch_size": 32,
    "lambda_max": 0.2,
    "warmup_epochs": 10,
    "patience": 20,
    "max_grad_norm": 1.0,
    "threshold": 0.80,
    "temperature": 0.1,
    "residual": True,
    "shortage_threshold": 0.50,
    "shortage_weight_alpha": 4.0,
    "loss_shortage_threshold": 0.60,
}

np.random.seed(42)
random.seed(42)
torch.manual_seed(42)

NUM_DAYS = 365
NUM_SAMPLES = 100
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Device: {device}")

print("\n[1/5] Rebuilding graph and data...")
nodes, edges, edge_index, adjacency, manufacturer_ids, node_roles = build_graph(
    num_nodes=500, ba_m=2, seed=42
)
NUM_NODES = len(nodes)
edge_weights_scaled = scale_edge_weights(edges)
transit_days_arr = [e["transit_days"] for e in edges]

all_samples = generate_scenarios(
    num_nodes=NUM_NODES, num_days=NUM_DAYS,
    manufacturer_ids=manufacturer_ids, adjacency=adjacency,
    node_roles=node_roles, num_samples=NUM_SAMPLES,
)

windowed_data = {}
for sample in all_samples:
    sid = sample["scenario_id"]
    xs, xi, y = create_windows(sample)
    windowed_data[sid] = {"X_shock": xs, "X_inv": xi, "Y": y}

scenario_ids = np.arange(NUM_SAMPLES)
np.random.shuffle(scenario_ids)
train_ids = scenario_ids[:70]
val_ids = scenario_ids[70:85]
test_ids = scenario_ids[85:]

def gather_split(ids):
    xs_all, xi_all, y_all = [], [], []
    for sid in ids:
        d = windowed_data[sid]
        xs_all.append(d["X_shock"])
        xi_all.append(d["X_inv"])
        y_all.append(d["Y"])
    return np.concatenate(xs_all), np.concatenate(xi_all), np.concatenate(y_all)

X_shock_train, X_inv_train, Y_train = gather_split(train_ids)
X_shock_val, X_inv_val, Y_val = gather_split(val_ids)
X_shock_test, X_inv_test, Y_test = gather_split(test_ids)

print(f"  Test: {X_shock_test.shape[0]} windows, {NUM_NODES} nodes, {T_FUTURE}-day horizon")

print("\n[2/5] Loading trained model...")
model = LifelineGNN(
    in_channels=2, hidden_dim=128, t_future=T_FUTURE,
    num_gcn_layers=2, gru_layers=2, dropout=0.15, num_heads=4,
)
model.load_state_dict(torch.load("data/model_weights.pt", map_location=device, weights_only=True))
model = model.to(device)
model.eval()
print(f"  Loaded {sum(p.numel() for p in model.parameters()):,} params")
full_model_params = sum(p.numel() for p in model.parameters())

ei = torch.tensor(edge_index, dtype=torch.long).to(device)
ew = torch.tensor(edge_weights_scaled, dtype=torch.float32).to(device)

X_test_t = torch.tensor(make_input(X_shock_test, X_inv_test), dtype=torch.float32)
test_loader = DataLoader(TensorDataset(X_test_t), batch_size=32)

test_preds = []
with torch.no_grad():
    for (xb,) in test_loader:
        xb = xb.to(device)
        test_preds.append(model(xb, ei, ew).cpu().numpy())
Y_pred_residual = np.concatenate(test_preds)

baseline_test = np.repeat(X_inv_test[:, :, -1:], T_FUTURE, axis=2)
Y_pred_test = np.clip(Y_pred_residual + baseline_test, 0, 1)
Y_baseline = baseline_test.copy()

print(f"  Model RMSE: {rmse(Y_test, Y_pred_test):.4f}")
print(f"  Persistence RMSE: {rmse(Y_test, Y_baseline):.4f}")

print("\n[3/5] Shortage-specific metrics...")

results = {"shortage_metrics": {}, "ood": {}, "ablation": {}, "per_role": {},
           "operational": {}, "calibration": {}}

for thresh in [0.5, 0.6, 0.7]:
    cls = shortage_classification(Y_test, Y_pred_test, threshold=thresh)
    cls_base = shortage_classification(Y_test, Y_baseline, threshold=thresh)
    lt = shortage_lead_time(Y_test, Y_pred_test, threshold=thresh)
    lt_base = shortage_lead_time(Y_test, Y_baseline, threshold=thresh)

    key = f"threshold_{thresh}"
    results["shortage_metrics"][key] = {
        "model": {**cls, "lead_time": lt},
        "baseline": {**cls_base, "lead_time": lt_base},
    }

    print(f"\n  Threshold < {thresh}:")
    print(f"    Model     — P={cls['precision']:.3f}  R={cls['recall']:.3f}  "
          f"F1={cls['f1']:.3f}  lead={lt['mean_days']:+.1f}d  "
          f"(early {lt['early_pct']:.0f}%)")
    print(f"    Baseline  — P={cls_base['precision']:.3f}  R={cls_base['recall']:.3f}  "
          f"F1={cls_base['f1']:.3f}  lead={lt_base['mean_days']:+.1f}d  "
          f"(early {lt_base['early_pct']:.0f}%)")

# Calibrated threshold (tuned on validation set)
baseline_val = np.repeat(X_inv_val[:, :, -1:], T_FUTURE, axis=2)
# Use model to predict on val set for calibration
X_val_t = torch.tensor(make_input(X_shock_val, X_inv_val), dtype=torch.float32)
val_loader_cal = DataLoader(TensorDataset(X_val_t), batch_size=32)
val_preds_cal = []
with torch.no_grad():
    for (xb,) in val_loader_cal:
        xb = xb.to(device)
        val_preds_cal.append(model(xb, ei, ew).cpu().numpy())
Y_pred_val_res = np.concatenate(val_preds_cal)
Y_pred_val = np.clip(Y_pred_val_res + baseline_val, 0, 1)

cal_result = calibrate_threshold(Y_val, Y_pred_val)
cal_thresh = cal_result["best_threshold"]
cal_cls = shortage_classification(Y_test, Y_pred_test, threshold=cal_thresh)
cal_lt = shortage_lead_time(Y_test, Y_pred_test, threshold=cal_thresh)
results["calibration"] = {
    "calibrated_threshold": cal_thresh,
    "calibration_best_f1_val": cal_result["best_score"],
    "test_f1_at_calibrated": cal_cls["f1"],
    "test_recall_at_calibrated": cal_cls["recall"],
    "test_precision_at_calibrated": cal_cls["precision"],
    "test_lead_time_at_calibrated": cal_lt,
    "all_scores": cal_result["all_scores"],
}
print(f"\n  Calibrated threshold: {cal_thresh} (val F1={cal_result['best_score']:.3f})")
print(f"    Test  — P={cal_cls['precision']:.3f}  R={cal_cls['recall']:.3f}  "
      f"F1={cal_cls['f1']:.3f}  lead={cal_lt['mean_days']:+.1f}d")

# Brier score
bs_model = brier_score(Y_test, Y_pred_test, threshold=0.5)
bs_base = brier_score(Y_test, Y_baseline, threshold=0.5)
results["operational"]["brier_score_model"] = round(bs_model, 6)
results["operational"]["brier_score_baseline"] = round(bs_base, 6)
print(f"\n  Brier score: model={bs_model:.4f}  baseline={bs_base:.4f}")

# Episode detection rate
for k_days in [1, 2, 3]:
    edr_model = episode_detection_rate(Y_test, Y_pred_test, threshold=0.5,
                                       min_lead_days=k_days)
    edr_base = episode_detection_rate(Y_test, Y_baseline, threshold=0.5,
                                      min_lead_days=k_days)
    results["operational"][f"episode_detect_{k_days}d_model"] = edr_model
    results["operational"][f"episode_detect_{k_days}d_baseline"] = edr_base
    print(f"  Episode detection (≥{k_days}d warning): "
          f"model={edr_model['detection_rate']:.1%}  "
          f"baseline={edr_base['detection_rate']:.1%}  "
          f"({edr_model['total_episodes']} episodes)")

# False alert rate
far_model = false_alert_rate(Y_test, Y_pred_test, threshold=0.5)
far_base = false_alert_rate(Y_test, Y_baseline, threshold=0.5)
results["operational"]["false_alert_model"] = far_model
results["operational"]["false_alert_baseline"] = far_base
print(f"  False alert rate: model={far_model['rate_per_node_per_window']:.4f}/node/window  "
      f"baseline={far_base['rate_per_node_per_window']:.4f}/node/window")

# Per-role breakdown
role_rmse_model = per_role_rmse(Y_test, Y_pred_test, node_roles)
role_rmse_base = per_role_rmse(Y_test, Y_baseline, node_roles)
results["per_role"] = {"model": role_rmse_model, "baseline": role_rmse_base}

print(f"\n  Per-role RMSE:")
for role in sorted(role_rmse_model.keys()):
    m = role_rmse_model[role]
    b = role_rmse_base[role]
    imp = (b - m) / b * 100 if b > 0 else 0
    print(f"    {role:<20s}  model={m:.4f}  baseline={b:.4f}  ({imp:+.1f}%)")

print("\n[4/5] Out-of-distribution evaluation...")

np.random.seed(99)
random.seed(99)
ood_samples = generate_ood_scenarios(
    num_nodes=NUM_NODES, num_days=NUM_DAYS,
    manufacturer_ids=manufacturer_ids, adjacency=adjacency,
    node_roles=node_roles, num_samples=15,
)

ood_xs, ood_xi, ood_y = [], [], []
for sample in ood_samples:
    xs, xi, y = create_windows(sample)
    ood_xs.append(xs)
    ood_xi.append(xi)
    ood_y.append(y)
X_shock_ood = np.concatenate(ood_xs)
X_inv_ood = np.concatenate(ood_xi)
Y_ood = np.concatenate(ood_y)
print(f"  OOD windows: {X_shock_ood.shape[0]}")

X_ood_t = torch.tensor(make_input(X_shock_ood, X_inv_ood), dtype=torch.float32)
ood_loader = DataLoader(TensorDataset(X_ood_t), batch_size=32)

ood_preds = []
with torch.no_grad():
    for (xb,) in ood_loader:
        xb = xb.to(device)
        ood_preds.append(model(xb, ei, ew).cpu().numpy())
Y_pred_ood_res = np.concatenate(ood_preds)
baseline_ood = np.repeat(X_inv_ood[:, :, -1:], T_FUTURE, axis=2)
Y_pred_ood = np.clip(Y_pred_ood_res + baseline_ood, 0, 1)

ood_rmse_model = rmse(Y_ood, Y_pred_ood)
ood_rmse_base = rmse(Y_ood, baseline_ood)
id_rmse = rmse(Y_test, Y_pred_test)
degradation = ood_degradation_ratio(id_rmse, ood_rmse_model)

results["ood"] = {
    "LifelineGNN": {
        "ood_rmse": round(ood_rmse_model, 6),
        "in_dist_rmse": round(id_rmse, 6),
        "degradation_ratio": round(degradation, 4),
    },
    "ood_rmse_baseline": round(ood_rmse_base, 6),
    "n_ood_windows": int(X_shock_ood.shape[0]),
}

print(f"  In-distribution RMSE:  {id_rmse:.4f}")
print(f"  OOD RMSE (model):     {ood_rmse_model:.4f}")
print(f"  OOD RMSE (baseline):  {ood_rmse_base:.4f}")
print(f"  Degradation ratio:    {degradation:.2f}x")

print("\n[5/5] Training ablation models (fair regimen = train_gpu.py)...")
np.random.seed(42)
random.seed(42)
torch.manual_seed(42)

ablation_models = {
    "TemporalOnlyGRU": TemporalOnlyGRU(
        in_channels=2, hidden_dim=128, t_future=T_FUTURE,
        gru_layers=2, dropout=0.15,
    ),
    "SpatialOnlyGNN": SpatialOnlyGNN(
        in_channels=2, hidden_dim=128, t_future=T_FUTURE,
        num_gcn_layers=2, dropout=0.15, num_heads=4,
    ),
    "MLPBaseline": MLPBaseline(
        in_channels=2, hidden_dim=128, t_past=T_PAST,
        t_future=T_FUTURE, dropout=0.15,
    ),
}

for name, abl_model in ablation_models.items():
    print(f"\n  Training {name}...")
    torch.manual_seed(42)

    t0 = time.time()
    best_state, hist = train(
        abl_model,
        (X_shock_train, X_inv_train, Y_train),
        (X_shock_val, X_inv_val, Y_val),
        edge_index, edge_weights_scaled,
        transit_days=transit_days_arr,
        device=device,
        **FAIR_TRAIN_KWARGS,
    )
    abl_time = time.time() - t0
    abl_epochs = len(hist["train_loss"])
    print(f"    {abl_epochs} epochs in {abl_time:.0f}s")

    abl_model.eval()
    abl_preds = []
    with torch.no_grad():
        for (xb,) in test_loader:
            xb = xb.to(device)
            abl_preds.append(abl_model(xb, ei, ew).cpu().numpy())
    Y_pred_abl_res = np.concatenate(abl_preds)
    Y_pred_abl = np.clip(Y_pred_abl_res + baseline_test, 0, 1)

    abl_rmse = rmse(Y_test, Y_pred_abl)
    abl_mae_val = mae(Y_test, Y_pred_abl)
    abl_cls = shortage_classification(Y_test, Y_pred_abl, threshold=0.5)

    # OOD evaluation for ablation model
    abl_ood_preds = []
    with torch.no_grad():
        for (xb,) in ood_loader:
            xb = xb.to(device)
            abl_ood_preds.append(abl_model(xb, ei, ew).cpu().numpy())
    Y_pred_abl_ood_res = np.concatenate(abl_ood_preds)
    Y_pred_abl_ood = np.clip(Y_pred_abl_ood_res + baseline_ood, 0, 1)
    abl_ood_rmse = rmse(Y_ood, Y_pred_abl_ood)
    abl_degradation = ood_degradation_ratio(abl_rmse, abl_ood_rmse)

    results["ablation"][name] = {
        "rmse": round(abl_rmse, 6),
        "mae": round(abl_mae_val, 6),
        "shortage_f1": abl_cls["f1"],
        "shortage_recall": abl_cls["recall"],
        "epochs": abl_epochs,
        "train_time_s": round(abl_time, 1),
        "params": sum(p.numel() for p in abl_model.parameters()),
    }

    results["ood"][name] = {
        "ood_rmse": round(abl_ood_rmse, 6),
        "in_dist_rmse": round(abl_rmse, 6),
        "degradation_ratio": round(abl_degradation, 4),
    }

    print(f"    RMSE={abl_rmse:.4f}  MAE={abl_mae_val:.4f}  "
          f"F1={abl_cls['f1']:.3f}  R={abl_cls['recall']:.3f}  "
          f"OOD={abl_ood_rmse:.4f} ({abl_degradation:.2f}x)")

print("\n" + "=" * 60)
print("SUMMARY")
print("=" * 60)

full_cls = shortage_classification(Y_test, Y_pred_test, threshold=0.5)
full_lt = shortage_lead_time(Y_test, Y_pred_test, threshold=0.5)
base_cls = shortage_classification(Y_test, Y_baseline, threshold=0.5)

sep = '\u2500'
print(f"\n  {'Model':<22} {'RMSE':>8} {'MAE':>8} {'F1@0.5':>8} {'Recall':>8} {'Params':>10} {'OOD':>8}")
print(f"  {sep*22} {sep*8} {sep*8} {sep*8} {sep*8} {sep*10} {sep*8}")
base_rmse = rmse(Y_test, Y_baseline)
base_mae = mae(Y_test, Y_baseline)
print(f"  {'Persistence':<22} {base_rmse:>8.4f} {base_mae:>8.4f} "
      f"{base_cls['f1']:>8.3f} {base_cls['recall']:>8.3f} {0:>10} {'—':>8}")
print(f"  {'LifelineGNN (full)':<22} {rmse(Y_test, Y_pred_test):>8.4f} "
      f"{mae(Y_test, Y_pred_test):>8.4f} {full_cls['f1']:>8.3f} "
      f"{full_cls['recall']:>8.3f} {full_model_params:>10,} {degradation:>7.2f}x")
for name, abl in results["ablation"].items():
    abl_deg = results["ood"].get(name, {}).get("degradation_ratio", 0)
    print(f"  {name:<22} {abl['rmse']:>8.4f} {abl['mae']:>8.4f} "
          f"{abl['shortage_f1']:>8.3f} {abl['shortage_recall']:>8.3f} "
          f"{abl['params']:>10,} {abl_deg:>7.2f}x")

print(f"\n  Lead time (model):  {full_lt['mean_days']:+.1f} days avg  "
      f"({full_lt['early_pct']:.0f}% early)")
print(f"  OOD degradation:   {degradation:.2f}x")

results["full_model"] = {
    "rmse": round(rmse(Y_test, Y_pred_test), 6),
    "mae": round(mae(Y_test, Y_pred_test), 6),
    "shortage_f1_0.5": full_cls["f1"],
    "shortage_recall_0.5": full_cls["recall"],
    "lead_time_mean": full_lt["mean_days"],
    "lead_time_early_pct": full_lt["early_pct"],
    "params": full_model_params,
}

results["persistence"] = {
    "rmse": round(base_rmse, 6),
    "mae": round(base_mae, 6),
    "shortage_f1_0.5": base_cls["f1"],
    "shortage_recall_0.5": base_cls["recall"],
    "params": 0,
}

results["ablation_fair"] = {
    "matches_train_gpu": True,
    "description": "Same train() kwargs as train_gpu.py LifelineGNN",
    **{k: (round(v, 6) if isinstance(v, float) else v) for k, v in FAIR_TRAIN_KWARGS.items()},
}

with open("data/eval_results.json", "w") as f:
    json.dump(results, f, indent=2)
print("\n  Saved data/eval_results.json")
print("\nDone!")
