"""Start The Twelfth Man locally:  .venv/bin/python run.py  →  http://127.0.0.1:8012"""
import os
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "backend"))

# Load settings such as ANTHROPIC_API_KEY from a local .env file (never committed to git).
env_file = ROOT / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            v = v.strip().strip('"').strip("'")
            if v and "your-key" not in v:
                os.environ[k.strip()] = v  # the .env file wins over the shell

if not (ROOT / "data" / "processed" / "model.json").exists():
    sys.exit("Model files missing. Run:  .venv/bin/python scripts/fetch_data.py && .venv/bin/python scripts/build_models.py")

import uvicorn  # noqa: E402

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8012))
    if "--no-browser" not in sys.argv:
        threading.Timer(1.5, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, reload="--reload" in sys.argv,
                app_dir=str(ROOT / "backend"))
