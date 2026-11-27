# Loaded by Python at start when this folder is on PYTHONPATH (the gate puts it there): applies shimlib.py when ENHANCE_SHIM=1,
# so a tool that starts more Python processes of its own is patched in every one of them.
import os
if os.environ.get("ENHANCE_SHIM") == "1":
    import shimlib
    shimlib.apply()
