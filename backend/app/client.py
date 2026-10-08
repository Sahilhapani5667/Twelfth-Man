"""Anthropic API connection used by Coach Twelve.

Needs ANTHROPIC_API_KEY and TWELFTH_MAN_MODEL in the environment (run.py loads them
from .env). Without them the assistant falls back to answers from the game plan.
"""
from __future__ import annotations

import os


class CoachClient:
    def __init__(self):
        self.client = None
        self.sdk = None
        self.model = os.environ.get("TWELFTH_MAN_MODEL", "")
        self.enabled = False
        self.reason = "Coach Twelve, our in-house AI coach, is offline."
        if os.environ.get("TWELFTH_MAN_OFFLINE"):
            self.reason = "Coach Twelve, our in-house AI coach, is switched off."
            return
        if not self.model or not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            return
        try:
            import anthropic
            self.sdk = anthropic
            self.client = anthropic.Anthropic(timeout=45.0, max_retries=1)
            self.enabled = True
            self.reason = "Coach Twelve, our in-house AI coach, is on."
        except Exception:
            self.reason = "Coach Twelve, our in-house AI coach, is unavailable right now."
