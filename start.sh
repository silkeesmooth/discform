#!/bin/sh
# DISCFORM launcher: serves the app locally (module scripts need http://)
cd "$(dirname "$0")"
python3 serve.py 2>/dev/null || python serve.py
