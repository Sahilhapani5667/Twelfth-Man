"""Logs each assistant API call with its token usage and cost (data/api_usage.jsonl)."""
from __future__ import annotations

import json
import time
from pathlib import Path

LOG = Path(__file__).resolve().parents[2] / "data" / "api_usage.jsonl"
# $ per million tokens: input, output, cache write (5-min), cache read
PRICE = {"in": 4.0, "out": 20.0, "cache_write": 5.0, "cache_read": 0.20}


def record(resp, kind: str) -> float:
    u = getattr(resp, "usage", None)
    if u is None:
        return 0.0
    inp = getattr(u, "input_tokens", 0) or 0
    out = getattr(u, "output_tokens", 0) or 0
    cw = getattr(u, "cache_creation_input_tokens", 0) or 0
    cr = getattr(u, "cache_read_input_tokens", 0) or 0
    cost = (inp * PRICE["in"] + out * PRICE["out"] + cw * PRICE["cache_write"] + cr * PRICE["cache_read"]) / 1e6
    try:
        with LOG.open("a") as f:
            f.write(json.dumps({"t": time.time(), "kind": kind, "model": getattr(resp, "model", ""), "in": inp, "out": out,
                                "cache_write": cw, "cache_read": cr, "cost": round(cost, 5)}) + "\n")
    except OSError:
        pass
    return cost


def spent_today() -> float:
    """Spend since midnight UTC, for the daily budget."""
    if not LOG.exists():
        return 0.0
    start = time.time() - time.time() % 86400
    out = 0.0
    for line in LOG.read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            if row.get("t", 0) >= start:
                out += row["cost"]
    return out


def total() -> float:
    if not LOG.exists():
        return 0.0
    return sum(json.loads(l)["cost"] for l in LOG.read_text().splitlines() if l.strip())
