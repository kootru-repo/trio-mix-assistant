"""Time as an injectable dependency, so the engine can be stepped deterministically."""

from __future__ import annotations

import time
from typing import Protocol


class Clock(Protocol):
    def monotonic(self) -> float: ...

    def perf_counter(self) -> float: ...

    def time(self) -> float: ...

    def sleep(self, seconds: float) -> None: ...

    def hhmmss(self) -> str: ...


class SystemClock:
    def monotonic(self) -> float:
        return time.monotonic()

    def perf_counter(self) -> float:
        return time.perf_counter()

    def time(self) -> float:
        return time.time()

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def hhmmss(self) -> str:
        return time.strftime("%H:%M:%S")


class ManualClock:
    def __init__(self, start: float = 0.0, wall: float = 0.0) -> None:
        self._now = start
        self._wall = wall

    def advance(self, seconds: float) -> None:
        self._now += seconds
        self._wall += seconds

    def monotonic(self) -> float:
        return self._now

    def perf_counter(self) -> float:
        return self._now

    def time(self) -> float:
        return self._wall

    def sleep(self, seconds: float) -> None:
        self.advance(max(0.0, seconds))

    def hhmmss(self) -> str:
        return time.strftime("%H:%M:%S", time.gmtime(self._wall))
