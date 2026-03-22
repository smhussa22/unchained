"""
Spatiotemporal graph models for normalized inventory forecasting.

LifelineGNN stacks graph attention (GATConv) with edge attributes per time step,
residual connections and layer normalization after each spatial layer, then a
multi-layer GRU over the encoded sequence and a linear head for T_future-step
outputs (residuals; unconstrained). Ablation baselines isolate temporal-only,
spatial-only, and MLP pathways for comparison.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch_geometric.nn import GATConv


class LifelineGNN(nn.Module):
    """Directed GAT encoder over time followed by GRU and linear forecast head."""

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

        # Spatial stack: GAT with residual and LayerNorm
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

        self.gru = nn.GRU(
            hidden_dim,
            hidden_dim,
            num_layers=gru_layers,
            batch_first=True,
            dropout=dropout if gru_layers > 1 else 0.0,
        )
        self._init_gru_bias()

        self.head = nn.Linear(hidden_dim, t_future)

    def _init_gru_bias(self):
        """Set GRU update-gate biases to one (Jozefowicz et al., 2015)."""
        for name, param in self.gru.named_parameters():
            if "bias" in name:
                n = param.size(0)
                param.data[n // 3 : 2 * n // 3].fill_(1.0)

    def forward(self, x_seq, edge_index, edge_weight):
        """
        Parameters
        ----------
        x_seq : Tensor, shape (B, N, T_past, C)
        edge_index : LongTensor, shape (2, E)
        edge_weight : Tensor, shape (E,)

        Returns
        -------
        Tensor, shape (B, N, T_future)
        """
        B, N, T, C = x_seq.shape

        offsets = torch.arange(B, device=x_seq.device).view(-1, 1, 1) * N
        batch_ei = (edge_index.unsqueeze(0) + offsets).reshape(2, -1)
        batch_ew = edge_weight.repeat(B)
        batch_ea = batch_ew.unsqueeze(-1)

        embeddings = []
        for t in range(T):
            x_t = x_seq[:, :, t, :].reshape(B * N, C)
            skip = self.skip_proj(x_t)

            h = x_t
            for i, (gcn, norm) in enumerate(
                zip(self.gcn_layers, self.gcn_norms)
            ):
                h_in = h
                h = gcn(h, batch_ei, edge_attr=batch_ea)
                h = norm(h)
                if i == 0:
                    h = h + skip
                else:
                    h = h + h_in
                h = F.relu(h)
                h = self.dropout(h)

            embeddings.append(h.reshape(B, N, -1))

        h_seq = torch.stack(embeddings, dim=2)
        h_seq = h_seq.reshape(B * N, T, -1)
        _, h_last = self.gru(h_seq)

        out = self.head(h_last[-1])
        return out.reshape(B, N, -1)


class TemporalOnlyGRU(nn.Module):
    """Per-node GRU baseline; graph arguments are ignored."""

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
        B, N, T, C = x_seq.shape
        x = x_seq.reshape(B * N, T, C)
        x = F.relu(self.proj(x))
        _, h_last = self.gru(x)
        out = self.head(h_last[-1])
        return out.reshape(B, N, -1)


class SpatialOnlyGNN(nn.Module):
    """GAT on time-averaged node features; temporal order is collapsed by mean."""

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

        x = x_seq.mean(dim=2)

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
            if i == 0:
                h = h + skip
            else:
                h = h + h_in
            h = F.relu(h)
            h = self.dropout(h)

        out = self.head(h)
        return out.reshape(B, N, -1)


class MLPBaseline(nn.Module):
    """Two-layer MLP on flattened lookback per node; graph arguments ignored."""

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
        B, N, T, C = x_seq.shape
        x = x_seq.reshape(B * N, T * C)
        out = self.mlp(x)
        return out.reshape(B, N, self.t_future)
