# Data artifacts

| File | Tracked in git | Purpose |
|------|----------------|---------|
| `.gitkeep` | Yes | Ensures `data/` exists when cloning |
| `preprocessed_meta.json` | Yes | `edge_index`, scaled edge weights, `T_PAST` / `T_FUTURE` / `STRIDE`, split IDs, baseline metrics |
| `topology_500_nodes.json` | Yes | Node/edge list for visualization (same graph as training) |
| `gpu_results.json` | Yes | Last training run metrics + history (from `train_gpu.py`) |
| `eval_results.json` | Yes | Last full evaluation (from `evaluate_gpu.py`) |
| `*.npz` | No (gitignored) | Cached train/val/test tensors — regenerate via notebook |
| `model_weights.pt` | No (gitignored) | PyTorch checkpoint — run `train_gpu.py` or copy from GPU machine |

**Regenerating weights:** `python train_gpu.py` (GPU recommended; CPU works but is slow).
