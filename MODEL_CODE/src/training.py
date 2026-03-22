"""
Training loop: optional residual targets, weighted sampling over windows,
Adam with cosine LR decay, combined prediction and physics loss with scheduled
lambda, gradient clipping, and early stopping on validation loss.
"""

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, TensorDataset, WeightedRandomSampler

from .loss import combined_loss, lambda_schedule


def make_input(x_shock, x_inv):
    """Stack shock and inventory channels → (W, N, T, 2)."""
    return np.stack([x_shock, x_inv], axis=-1)


def train(
    model,
    train_data,
    val_data,
    edge_index,
    edge_weight,
    *,
    epochs=30,
    lr=1e-3,
    batch_size=32,
    lambda_max=0.1,
    warmup_epochs=5,
    patience=5,
    max_grad_norm=1.0,
    threshold=0.80,
    temperature=0.1,
    transit_days=None,
    device=None,
    residual=True,
    shortage_threshold=0.75,
    shortage_weight_alpha=0.0,
    loss_shortage_threshold=0.6,
    ema_alpha=0.2,
):
    """Train model; returns (best_state_dict, history dict).

    Parameters
    ----------
    residual : bool
        If True, regress future minus last observed inventory and optionally
        use WeightedRandomSampler on shortage windows; flow loss uses the
        last-inventory baseline to reconstruct absolute levels.
    shortage_threshold : float
        Minimum inventory across the window below which the window is
        treated as shortage-stratified for sampling.
    shortage_weight_alpha : float
        Multiplier for shortage-weighted MSE (see ``loss.shortage_weighted_mse_loss``).
    loss_shortage_threshold : float
        Absolute-inventory level entering the shortage weight map.
    ema_alpha : float
        EMA smoothing coefficient for validation RMSE series.
    """
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    model = model.to(device)
    ei = torch.tensor(edge_index, dtype=torch.long).to(device)
    ew = torch.tensor(edge_weight, dtype=torch.float32).to(device)
    td = (
        torch.tensor(transit_days, dtype=torch.long).to(device)
        if transit_days is not None
        else None
    )

    X_train = torch.tensor(
        make_input(train_data[0], train_data[1]), dtype=torch.float32
    )
    Y_train = torch.tensor(train_data[2], dtype=torch.float32)
    X_val = torch.tensor(
        make_input(val_data[0], val_data[1]), dtype=torch.float32
    )
    Y_val = torch.tensor(val_data[2], dtype=torch.float32)

    sampler = None

    if residual:
        t_future = Y_train.shape[-1]
        baseline_train = X_train[:, :, -1, 1].unsqueeze(-1).expand(-1, -1, t_future).clone()
        baseline_val = X_val[:, :, -1, 1].unsqueeze(-1).expand(-1, -1, Y_val.shape[-1]).clone()

        has_shortage = Y_train.amin(dim=(1, 2)) < shortage_threshold
        n_shortage = int(has_shortage.sum().item())
        n_normal = len(has_shortage) - n_shortage
        print(f"  Shortage windows: {n_shortage}/{len(has_shortage)} "
              f"({100 * n_shortage / len(has_shortage):.0f}%)")

        if n_shortage > 0 and n_normal > 0:
            w_short = 1.0 / n_shortage
            w_norm = 1.0 / n_normal
            sample_weights = torch.where(has_shortage, w_short, w_norm)
            sampler = WeightedRandomSampler(
                sample_weights.double(), len(sample_weights), replacement=True
            )

        Y_train = Y_train - baseline_train
        Y_val = Y_val - baseline_val

        train_ds = TensorDataset(X_train, Y_train, baseline_train)
        val_ds = TensorDataset(X_val, Y_val, baseline_val)
    else:
        train_ds = TensorDataset(X_train, Y_train)
        val_ds = TensorDataset(X_val, Y_val)

    train_loader = DataLoader(
        train_ds, batch_size=batch_size,
        sampler=sampler, shuffle=(sampler is None),
    )
    val_loader = DataLoader(val_ds, batch_size=batch_size)

    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=epochs, eta_min=lr * 0.01
    )

    history = {
        "train_loss": [],
        "val_loss": [],
        "val_combined_loss": [],
        "val_rmse": [],
        "val_rmse_ema": [],
        "mse_component": [],
        "flow_component": [],
        "flow_to_mse_ratio": [],
        "lambda": [],
        "grad_norm": [],
    }
    best_val_loss = float("inf")
    patience_counter = 0
    best_state = None
    ema_val_rmse = None

    for epoch in range(epochs):
        lam = lambda_schedule(epoch, lambda_max, warmup_epochs, epochs)
        model.train()

        epoch_loss = 0.0
        epoch_mse = 0.0
        epoch_flow = 0.0
        epoch_grad = 0.0
        n_batches = 0

        for batch in train_loader:
            if residual:
                xb, yb, base_b = batch
                xb, yb, base_b = xb.to(device), yb.to(device), base_b.to(device)
            else:
                xb, yb = batch
                xb, yb = xb.to(device), yb.to(device)
                base_b = None

            optimizer.zero_grad()
            y_pred = model(xb, ei, ew)

            loss, components = combined_loss(
                y_pred,
                yb,
                ei,
                ew,
                lambda_flow=lam,
                threshold=threshold,
                temperature=temperature,
                transit_days=td,
                baseline=base_b,
                shortage_threshold=loss_shortage_threshold,
                shortage_weight_alpha=shortage_weight_alpha,
            )
            loss.backward()

            grad_norm = torch.nn.utils.clip_grad_norm_(
                model.parameters(), max_grad_norm
            )

            optimizer.step()

            epoch_loss += components["total"] * xb.size(0)
            epoch_mse += components["mse"] * xb.size(0)
            epoch_flow += components["flow"] * xb.size(0)
            epoch_grad += grad_norm.item()
            n_batches += 1

        n_train = len(train_loader.dataset)
        epoch_loss /= n_train
        epoch_mse /= n_train
        epoch_flow /= n_train
        epoch_grad /= max(n_batches, 1)

        model.eval()
        val_loss = 0.0
        val_combined = 0.0
        val_preds, val_trues = [], []
        with torch.no_grad():
            for batch in val_loader:
                if residual:
                    xb, yb, base_b = batch
                else:
                    xb, yb = batch
                    base_b = None
                xb, yb = xb.to(device), yb.to(device)
                y_pred = model(xb, ei, ew)
                val_loss += F.mse_loss(y_pred, yb).item() * xb.size(0)
                _, v_comp = combined_loss(
                    y_pred, yb, ei, ew,
                    lambda_flow=lam,
                    threshold=threshold,
                    temperature=temperature,
                    transit_days=td,
                    baseline=base_b.to(device) if base_b is not None else None,
                    shortage_threshold=loss_shortage_threshold,
                    shortage_weight_alpha=shortage_weight_alpha,
                )
                val_combined += v_comp["total"] * xb.size(0)
                if base_b is not None:
                    y_pred_abs = (y_pred + base_b.to(device)).cpu().numpy()
                    y_true_abs = (yb + base_b.to(device)).cpu().numpy()
                else:
                    y_pred_abs = y_pred.cpu().numpy()
                    y_true_abs = yb.cpu().numpy()
                val_preds.append(y_pred_abs)
                val_trues.append(y_true_abs)
        val_loss /= len(val_loader.dataset)
        val_combined /= len(val_loader.dataset)
        val_rmse = float(
            np.sqrt(
                np.mean(
                    (np.concatenate(val_trues) - np.concatenate(val_preds))
                    ** 2
                )
            )
        )

        history["train_loss"].append(epoch_loss)
        history["val_loss"].append(val_loss)
        history["val_combined_loss"].append(val_combined)
        history["val_rmse"].append(val_rmse)
        history["mse_component"].append(epoch_mse)
        history["flow_component"].append(epoch_flow)

        flow_mse_ratio = epoch_flow / max(epoch_mse, 1e-12)
        history["flow_to_mse_ratio"].append(flow_mse_ratio)

        ema_val_rmse = (
            val_rmse if ema_val_rmse is None
            else ema_alpha * val_rmse + (1 - ema_alpha) * ema_val_rmse
        )
        history["val_rmse_ema"].append(ema_val_rmse)

        history["lambda"].append(lam)
        history["grad_norm"].append(epoch_grad)

        current_lr = optimizer.param_groups[0]["lr"]
        history.setdefault("lr", []).append(current_lr)

        print(
            f"Epoch {epoch + 1:>2}/{epochs}  "
            f"loss={epoch_loss:.5f}  val_loss={val_loss:.5f}  "
            f"val_rmse={val_rmse:.4f}  "
            f"lam={lam:.3f}  gnorm={epoch_grad:.2f}  "
            f"lr={current_lr:.2e}"
        )

        scheduler.step()

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            patience_counter = 0
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
        else:
            patience_counter += 1
            if patience_counter >= patience:
                print(f"Early stopping at epoch {epoch + 1}")
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    return best_state, history
