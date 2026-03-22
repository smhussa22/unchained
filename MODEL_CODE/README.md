# Lifeline — model code (Python)

This directory contains the **Python training and evaluation pipeline** for the spatiotemporal GNN (**LifelineGNN**: GAT + GRU, residual prediction, physics-informed loss).

> **Data:** All series are **simulated** for research and reproducibility — not real hospital systems.

## Layout

| Path | Purpose |
|------|---------|
| `train_gpu.py` | Training → `data/model_weights.pt`, `data/gpu_results.json` |
| `evaluate_gpu.py` | Shortage / OOD / ablations → `data/eval_results.json` |
| `src/model.py` | `LifelineGNN` and ablations |
| `src/training.py` | Training loop, `make_input` |
| `src/loss.py` | MSE + physics flow + shortage weighting |
| `src/data_generation.py` | Scenario generators (incl. OOD) |
| `src/graph.py` | Graph build, edge weights |
| `src/evaluation.py` | Metrics (RMSE, shortage F1, OOD, etc.) |
| `data/README.md` | Artifact notes |

## Quick start

```bash
cd MODEL_CODE
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python train_gpu.py        # GPU recommended
python evaluate_gpu.py
```

Training kwargs in `train_gpu.py` should stay aligned with `FAIR_TRAIN_KWARGS` in `evaluate_gpu.py` for comparable ablation runs.

## License

See [LICENSE](LICENSE) (MIT).
