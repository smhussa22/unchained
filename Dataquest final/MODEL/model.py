"""
Hardened LifelineGNN model with architecture fixes.

Addresses **Vector 3 — Graph / Architecture Flaws**:

1. **Over-smoothing** in message passing
   * Upgraded to *Graph Attention Networks* (GATConv) so the network
     dynamically learns which supply edges matter during a crisis,
     preventing the signal from being diluted by massive hubs.
   * Added *residual (skip) connections* after each GAT layer so node
     features retain local identity even as messages propagate.
   * Added *LayerNorm* after each GAT layer to stabilise activations.
   * Added *Dropout* (default p=0.1) to regularise the spatial encoder.

2. **Vanishing gradients** in the GRU over 14-step look-back
   * Switched to a **2-layer GRU** with *dropout between layers* for
     better long-range gradient flow.
   * Initialised GRU forget-gate biases to 1.0 (Jozefowicz et al., 2015)
     so the default behaviour is to *remember*, not forget.

3. **Directionality**
   * GATConv respects the directed ``edge_index`` provided by the
     supply-chain graph builder, ensuring messages only flow downstream
     (manufacturer → hub → hospital).

4. **Ablation defence** (Vector 1)
   * ``TemporalOnlyGRU`` — strips the graph, uses only a GRU.
   * ``SpatialOnlyGNN`` — strips the temporal sequence, uses only GAT on
     a single aggregated timestep.
   When the full ``LifelineGNN`` outperforms both, it mathematically
   proves that *both* graph topology and temporal sequencing are required.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch_geometric.nn import GATConv


class LifelineGNN(nn.Module):
    """Spatiotemporal GNN with GAT attention + multi-layer GRU."""

    def __init__(
        self,
        in_channels=2,
        hidden_dim=64,
        t_future=14,
        num_gcn_layers=2,
        gru_layers=2,
        dropout=0.1,
        num_heads=4,
    ):
        super().__init__()
        self.num_heads = num_heads
        if hidden_dim % num_heads != 0:
            raise ValueError(
                f"hidden_dim ({hidden_dim}) must be divisible by "
                f"num_heads ({num_heads})"
            )

        # ── Spatial encoder: GAT with residual + LayerNorm ────────────
        self.gcn_layers = nn.ModuleList()
        self.gcn_norms = nn.ModuleList()
        for i in range(num_gcn_layers):
            in_c = in_channels if i == 0 else hidden_dim
            # Each head outputs hidden_dim // num_heads; concatenation
            # restores the full hidden_dim.
            self.gcn_layers.append(
                GATConv(
                    in_c,
                    hidden_dim // num_heads,
                    heads=num_heads,
                    concat=True,
                    dropout=dropout,
                    edge_dim=1,
                )
            )
            self.gcn_norms.append(nn.LayerNorm(hidden_dim))

        # Linear projection for the skip connection when in_channels ≠ hidden_dim
        self.skip_proj = (
            nn.Linear(in_channels, hidden_dim)
            if in_channels != hidden_dim
            else nn.Identity()
        )
        self.dropout = nn.Dropout(dropout)

        # ── Temporal encoder: multi-layer GRU ─────────────────────────
        self.gru = nn.GRU(
            hidden_dim,
            hidden_dim,
            num_layers=gru_layers,
            batch_first=True,
            dropout=dropout if gru_layers > 1 else 0.0,
        )
        self._init_gru_bias()

        # ── Forecast head ─────────────────────────────────────────────
        self.head = nn.Linear(hidden_dim, t_future)

    # ── GRU bias initialisation (Vector 3) ────────────────────────────
    def _init_gru_bias(self):
        """Set GRU forget-gate biases to 1 so the default is 'remember'."""
        for name, param in self.gru.named_parameters():
            if "bias" in name:
                n = param.size(0)
                # GRU bias layout: [reset, update, new] each of size hidden
                # "update" gate (index n//3 : 2*n//3) → set to 1
                param.data[n // 3 : 2 * n // 3].fill_(1.0)

    def forward(self, x_seq, edge_index, edge_weight):
        """
        Parameters
        ----------
        x_seq : (B, N, T_past, C)
        edge_index : (2, E)
        edge_weight : (E,)

        Returns
        -------
        (B, N, T_future)
        """
        B, N, T, C = x_seq.shape

        # Replicate graph for each batch item
        offsets = torch.arange(B, device=x_seq.device).view(-1, 1, 1) * N
        batch_ei = (edge_index.unsqueeze(0) + offsets).reshape(2, -1)
        batch_ew = edge_weight.repeat(B)
        # GATConv expects edge_attr of shape (E, edge_dim)
        batch_ea = batch_ew.unsqueeze(-1)

        embeddings = []
        for t in range(T):
            x_t = x_seq[:, :, t, :].reshape(B * N, C)
            # Save input for skip connection
            skip = self.skip_proj(x_t)

            h = x_t
            for i, (gcn, norm) in enumerate(
                zip(self.gcn_layers, self.gcn_norms)
            ):
                h_in = h
                h = gcn(h, batch_ei, edge_attr=batch_ea)
                h = norm(h)
                # Residual connection: skip projection for first layer,
                # direct residual for subsequent layers (dims already match)
                if i == 0:
                    h = h + skip
                else:
                    h = h + h_in
                h = F.relu(h)
                h = self.dropout(h)

            embeddings.append(h.reshape(B, N, -1))

        h_seq = torch.stack(embeddings, dim=2)  # (B, N, T, H)
        h_seq = h_seq.reshape(B * N, T, -1)
        _, h_last = self.gru(h_seq)  # (num_layers, B*N, H)

        out = self.head(h_last[-1])  # (B*N, T_future) — unconstrained for residual prediction
        return out.reshape(B, N, -1)


# ═══════════════════════════════════════════════════════════════════════
# Ablation models  (Vector 1 — proving graph + temporal are both needed)
# ═══════════════════════════════════════════════════════════════════════

class TemporalOnlyGRU(nn.Module):
    """Ablation baseline: GRU *without* any graph structure.

    Processes each node independently through a GRU and linear head.
    If the full ``LifelineGNN`` outperforms this model, it proves that
    the graph topology contributes meaningful signal.
    """

    def __init__(
        self,
        in_channels=2,
        hidden_dim=64,
        t_future=14,
        gru_layers=2,
        dropout=0.1,
    ):
        super().__init__()
        self.proj = nn.Linear(in_channels, hidden_dim)
        self.gru = nn.GRU(
            hidden_dim,
            hidden_dim,
            num_layers=gru_layers,
            batch_first=True,
            dropout=dropout if gru_layers > 1 else 0.0,
        )
        self.head = nn.Linear(hidden_dim, t_future)

    def forward(self, x_seq, edge_index=None, edge_weight=None):
        """``edge_index`` and ``edge_weight`` are accepted but ignored."""
        B, N, T, C = x_seq.shape
        x = x_seq.reshape(B * N, T, C)
        x = F.relu(self.proj(x))
        _, h_last = self.gru(x)
        out = self.head(h_last[-1])
        return out.reshape(B, N, -1)


class SpatialOnlyGNN(nn.Module):
    """Ablation baseline: GAT *without* temporal sequencing.

    Averages all timesteps into a single snapshot, applies graph
    attention, and forecasts.  If the full ``LifelineGNN`` outperforms
    this model, it proves that temporal sequencing is required.
    """

    def __init__(
        self,
        in_channels=2,
        hidden_dim=64,
        t_future=14,
        num_gcn_layers=2,
        dropout=0.1,
        num_heads=4,
    ):
        super().__init__()
        self.gcn_layers = nn.ModuleList()
        self.gcn_norms = nn.ModuleList()
        for i in range(num_gcn_layers):
            in_c = in_channels if i == 0 else hidden_dim
            self.gcn_layers.append(
                GATConv(
                    in_c,
                    hidden_dim // num_heads,
                    heads=num_heads,
                    concat=True,
                    dropout=dropout,
                    edge_dim=1,
                )
            )
            self.gcn_norms.append(nn.LayerNorm(hidden_dim))

        self.skip_proj = (
            nn.Linear(in_channels, hidden_dim)
            if in_channels != hidden_dim
            else nn.Identity()
        )
        self.dropout = nn.Dropout(dropout)
        self.head = nn.Linear(hidden_dim, t_future)

    def forward(self, x_seq, edge_index, edge_weight):
        B, N, T, C = x_seq.shape

        # Collapse time: average across all timesteps
        x = x_seq.mean(dim=2)  # (B, N, C)

        offsets = torch.arange(B, device=x.device).view(-1, 1, 1) * N
        batch_ei = (edge_index.unsqueeze(0) + offsets).reshape(2, -1)
        batch_ew = edge_weight.repeat(B)
        batch_ea = batch_ew.unsqueeze(-1)

        h = x.reshape(B * N, C)
        skip = self.skip_proj(h)

        for i, (gcn, norm) in enumerate(
            zip(self.gcn_layers, self.gcn_norms)
        ):
            h_in = h
            h = gcn(h, batch_ei, edge_attr=batch_ea)
            h = norm(h)
            # Residual connection: skip projection for first layer,
            # direct residual for subsequent layers (dims already match)
            if i == 0:
                h = h + skip
            else:
                h = h + h_in
            h = F.relu(h)
            h = self.dropout(h)

        out = self.head(h)
        return out.reshape(B, N, -1)


class MLPBaseline(nn.Module):
    """Graph-free feedforward baseline.

    Flattens the temporal input per node and processes each node
    independently through a 2-layer MLP.  If the full ``LifelineGNN``
    does not significantly outperform this model, the graph structure
    is not contributing meaningful signal.
    """

    def __init__(self, in_channels=2, hidden_dim=64, t_past=14,
                 t_future=14, dropout=0.1):
        super().__init__()
        self.t_future = t_future
        self.mlp = nn.Sequential(
            nn.Linear(in_channels * t_past, hidden_dim),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, t_future),
        )

    def forward(self, x_seq, edge_index=None, edge_weight=None):
        # x_seq: (B, N, T, C) — accepts but ignores graph arguments
        B, N, T, C = x_seq.shape
        x = x_seq.reshape(B * N, T * C)
        out = self.mlp(x)
        return out.reshape(B, N, self.t_future)
