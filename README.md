# Unchained

Unchained is a full-stack prototype for exploring how disruptions ripple through a medical supply chain.

The repository combines:

- a **Next.js + deck.gl frontend** for interactive map-based scenario exploration
- a **PyTorch / PyTorch Geometric modeling pipeline** for training and evaluating the `LifelineGNN` forecasting model

> **Important:** The data in this repository is simulated for research and reproducibility. It does not represent a live hospital system.

## What the project does

The frontend visualizes a simplified healthcare supply chain that runs from a manufacturer to a hospital. Users can trigger a disruption at key non-hospital nodes and watch the downstream impact over time, including:

- node and edge health across the network
- a hospital supply forecast over a 14-day window
- critical-threshold alerts
- suggested response actions as supply declines
- real-world context for each disruption scenario

The modeling code in `MODEL_CODE/` trains and evaluates **LifelineGNN**, a spatiotemporal graph neural network used to generate and assess these forecasts.

## Repository structure

```text
.
├── README.md
├── Dataquest final/
│   └── frontend/              # Next.js application and interactive visualization
└── MODEL_CODE/                # Python model training and evaluation pipeline
```

### Frontend

Path: `Dataquest final/frontend`

Main pieces:

- `app/page.tsx` — renders the main map experience
- `components/Map.tsx` — deck.gl / Mapbox visualization and network state logic
- `components/DisasterMenu.tsx` — scenario details, playback, and hospital response panel
- `app/supply_chain_graph/graph_data.ts` — supply chain topology used by the UI
- `app/supply_chain_graph/forecast_data.ts` — forecast JSON loader for the visualization

### Model pipeline

Path: `MODEL_CODE`

Main pieces:

- `train_gpu.py` — training entrypoint
- `evaluate_gpu.py` — evaluation and ablation entrypoint
- `src/model.py` — `LifelineGNN` architecture
- `src/training.py` — training loop and input construction
- `src/evaluation.py` — evaluation metrics
- `src/loss.py` — loss composition
- `src/data_generation.py` — synthetic scenario generation
- `data/` — generated artifacts and tracked metadata

For model-specific details, see [`MODEL_CODE/README.md`](./MODEL_CODE/README.md).

## Tech stack

### Frontend

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS 4
- deck.gl
- Mapbox / react-map-gl

### Modeling

- Python
- PyTorch
- PyTorch Geometric
- NumPy
- NetworkX
- pytest

## Getting started

Because the repo has separate frontend and model workflows, you can work with either side independently.

### 1) Frontend setup

```bash
cd "Dataquest final/frontend"
npm install
```

Create a local environment file before running the app:

```bash
cat <<'EOF' > .env.local
NEXT_PUBLIC_MAPBOX_TOKEN=your_mapbox_public_token_here
EOF
```

Then start the development server:

```bash
npm run dev
```

Open <http://localhost:3000>.

### 2) Model setup

```bash
cd MODEL_CODE
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Train and evaluate:

```bash
python train_gpu.py
python evaluate_gpu.py
```

## Common commands

### Frontend commands

Run these from:

`Dataquest final/frontend`

| Command | Purpose |
|---|---|
| `npm run dev` | Start the local development server |
| `npm run build` | Build the production app |
| `npm start` | Run the production build |
| `npm run lint` | Run ESLint |

### Model commands

Run these from:

`MODEL_CODE`

| Command | Purpose |
|---|---|
| `make install` | Install Python dependencies |
| `make train` | Train the model |
| `make evaluate` | Run evaluation and ablations |
| `make reproduce` | Install, train, and evaluate in sequence |
| `make clean` | Remove generated weight and result files |

## Data and outputs

Tracked model artifacts live in `MODEL_CODE/data/`.

Important files include:

- `preprocessed_meta.json` — preprocessing metadata, graph structure, and split information
- `topology_500_nodes.json` — graph topology used for visualization/alignment
- `gpu_results.json` — training metrics from the last run
- `eval_results.json` — evaluation results from the last run

Ignored artifacts include:

- `model_weights.pt`
- cached `.npz` tensors

See [`MODEL_CODE/data/README.md`](./MODEL_CODE/data/README.md) for more detail.

## How the frontend experience works

At a high level, the UI models a chain like:

`Manufacturer -> Port -> Distribution -> Distribution -> Hospital`

The interactive map:

1. renders nodes and edges on a geographic view
2. lets users select a disruption point in the supply chain
3. animates the impact over a 14-day period
4. colors the network by health state
5. highlights severed routes
6. shows the hospital's projected supply and recommended actions

This makes the application useful as a storytelling/demo layer on top of the forecasting work in `MODEL_CODE/`.

## Notes for development

- The frontend requires `NEXT_PUBLIC_MAPBOX_TOKEN` at build time and runtime.
- The project includes a frontend-specific warning in `Dataquest final/frontend/AGENTS.md` noting that the app uses **Next.js 16**, which includes breaking changes compared with older versions.
- The model workflow recommends GPU usage for training, although CPU execution is still possible and slower.
- Training arguments in `train_gpu.py` should stay aligned with `FAIR_TRAIN_KWARGS` in `evaluate_gpu.py` for fair ablation comparisons.

## License

The modeling pipeline includes an MIT license at [`MODEL_CODE/LICENSE`](./MODEL_CODE/LICENSE).
