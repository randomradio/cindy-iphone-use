"""Cindy entry: preserve upstream protocol/state, forbid automatic service recovery."""
import signal
import sys
import iphone_use

runtime = iphone_use.Runtime()
original_ready = runtime.ready

def ready(screenshot=False, recover=False):
    if recover:
        raise iphone_use.WDAError("recovery_disabled", "Cindy uses the existing PUA service. Manage recovery explicitly outside this adapter.")
    return original_ready(screenshot=screenshot, recover=False)

runtime.ready = ready

def stop(*_):
    runtime.close()
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    iphone_use.serve(runtime)
finally:
    runtime.close()
