"""Train LifelineGNN on synthetic scenarios; write ``data/gpu_results.json`` and ``data/model_weights.pt``."""
import json
import random
import time

import numpy as np
import torch

from src.graph import build_graph, scale_edge_weights
from src.data_generation import (
    generate_scenarios, generate_ood_scenarios, create_windows,
    T_PAST, T_FUTURE, STRIDE,
)
from src.evaluation import rmse, mae, physics_imbalance_score, ood_degradation_ratio
from src.model import LifelineGNN, TemporalOnlyGRU, SpatialOnlyGNN
from src.training import train, make_input

np.random.seed(42)
random.seed(42)
torch.manual_seed(42)

NUM_DAYS = 365
NUM_SAMPLES = 100
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Device: {device}")
if device.type == "cuda":
    print(f"GPU: {torch.cuda.get_device_name(0)}")

print("\n[1/6] Building graph...")
nodes, edges, edge_index, adjacency, manufacturer_ids, node_roles = build_graph(
    num_nodes=500, ba_m=2, seed=42
)
NUM_NODES = len(nodes)
edge_weights_scaled = scale_edge_weights(edges)
transit_days_arr = [e["transit_days"] for e in edges]
print(f"  {NUM_NODES} nodes, {len(edges)} edges")

print("\n[2/6] Generating scenarios...")
t0 = time.time()
all_samples = generate_scenarios(
    num_nodes=NUM_NODES, num_days=NUM_DAYS,
    manufacturer_ids=manufacturer_ids, adjacency=adjacency,
    node_roles=node_roles, num_samples=NUM_SAMPLES,
    multi_shock_prob=0.20, demand_variability=True,
)
print(f"  {len(all_samples)} scenarios in {time.time()-t0:.1f}s")

print("\n[3/6] Windowing and splitting...")
windowed_data = {}
for sample in all_samples:
    sid = sample["scenario_id"]
    xs, xi, y = create_windows(sample, t_past=T_PAST, t_future=T_FUTURE, stride=STRIDE)
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
print(f"  Train: {X_shock_train.shape[0]} windows")
print(f"  Val:   {X_shock_val.shape[0]} windows")
print(f"  Test:  {X_shock_test.shape[0]} windows")

Y_baseline = np.repeat(X_inv_test[:, :, -1:], T_FUTURE, axis=2)
baseline_rmse = rmse(Y_test, Y_baseline)
baseline_mae = mae(Y_test, Y_baseline)
baseline_phis = physics_imbalance_score(Y_baseline, edges, edge_weights_scaled)
print(f"\n  Persistence baseline: RMSE={baseline_rmse:.4f}, MAE={baseline_mae:.4f}")

print("\n[4/6] Training LifelineGNN (GAT) with residual prediction...")
model = LifelineGNN(
    in_channels=2, hidden_dim=128, t_future=T_FUTURE,
    num_gcn_layers=2, gru_layers=2, dropout=0.15, num_heads=4,
).to(device)
print(f"  Parameters: {sum(p.numel() for p in model.parameters()):,}")

# Training hyperparameters mirror ``FAIR_TRAIN_KWARGS`` in ``evaluate_gpu.py`` for fair comparison.
t0 = time.time()
best_state, history = train(
    model,
    (X_shock_train, X_inv_train, Y_train),
    (X_shock_val, X_inv_val, Y_val),
    edge_index, edge_weights_scaled,
    epochs=100, lr=3e-3, batch_size=32,
    lambda_max=0.2, warmup_epochs=10, patience=20,
    max_grad_norm=1.0, transit_days=transit_days_arr,
    threshold=0.80, temperature=0.1,
    residual=True, shortage_threshold=0.50,
    shortage_weight_alpha=4.0, loss_shortage_threshold=0.60,
    device=device,
)
train_time = time.time() - t0
n_epochs = len(history["train_loss"])
print(f"\n  Trained {n_epochs} epochs in {train_time:.1f}s ({train_time/n_epochs:.1f}s/epoch)")

print("\n[5/6] Evaluating on test set...")
ei = torch.tensor(edge_index, dtype=torch.long).to(device)
ew = torch.tensor(edge_weights_scaled, dtype=torch.float32).to(device)

model.eval()
test_preds = []
X_test_input = make_input(X_shock_test, X_inv_test)
X_test_t = torch.tensor(X_test_input, dtype=torch.float32)

from torch.utils.data import DataLoader, TensorDataset
test_loader = DataLoader(
    TensorDataset(X_test_t, torch.tensor(Y_test, dtype=torch.float32)),
    batch_size=32,
)
with torch.no_grad():
    for xb, yb in test_loader:
        xb = xb.to(device)
        test_preds.append(model(xb, ei, ew).cpu().numpy())

Y_pred_residual = np.concatenate(test_preds)

baseline_test = np.repeat(X_inv_test[:, :, -1:], T_FUTURE, axis=2)
Y_pred_test = np.clip(Y_pred_residual + baseline_test, 0, 1)

model_rmse = rmse(Y_test, Y_pred_test)
model_mae = mae(Y_test, Y_pred_test)
model_phis = physics_imbalance_score(Y_pred_test, edges, edge_weights_scaled)

rmse_imp = (baseline_rmse - model_rmse) / baseline_rmse * 100
mae_imp = (baseline_mae - model_mae) / baseline_mae * 100

print(f"\n  {'Metric':<28} {'Persistence':>12} {'ST-GNN':>12} {'Improvement':>12}")
sep = '\u2500'
print(f"  {sep*28} {sep*12} {sep*12} {sep*12}")
for label, b, m in [('RMSE', baseline_rmse, model_rmse),
                     ('MAE', baseline_mae, model_mae),
                     ('Physics Imbalance', baseline_phis, model_phis)]:
    pct = (b - m) / b * 100 if b != 0 else 0
    print(f"  {label:<28} {b:>12.4f} {m:>12.4f} {pct:>11.1f}%")

print("\n[6/6] Saving results...")
results = {
    "device": str(device),
    "gpu_name": torch.cuda.get_device_name(0) if device.type == "cuda" else "cpu",
    "n_epochs": n_epochs,
    "train_time_seconds": round(train_time, 1),
    "residual_prediction": True,
    "shock_aware_sampling": True,
    "flow_gate_threshold": 0.80,
    "shortage_weight_alpha": 4.0,
    "loss_shortage_threshold": 0.60,
    "history": {k: [round(v, 6) for v in vals] for k, vals in history.items()},
    "baseline": {"rmse": round(baseline_rmse, 6), "mae": round(baseline_mae, 6), "phis": round(baseline_phis, 6)},
    "model": {"rmse": round(model_rmse, 6), "mae": round(model_mae, 6), "phis": round(model_phis, 6)},
    "improvement": {"rmse_pct": round(rmse_imp, 2), "mae_pct": round(mae_imp, 2)},
}

with open("data/gpu_results.json", "w") as f:
    json.dump(results, f, indent=2)

torch.save(model.state_dict(), "data/model_weights.pt")
print("  Saved data/gpu_results.json and data/model_weights.pt")
print("\nDone!")
