import json
import unittest

from trio_mix.clock import ManualClock
from trio_mix.engine import Engine

STEPS = 480
TICK = 0.05


def run_show(steps: int = STEPS) -> tuple[list[dict], str]:
    clock = ManualClock(start=100.0, wall=1_700_000_000.0)
    engine = Engine(sim=True, tick=TICK, clock=clock)
    last = clock.monotonic()
    for _ in range(steps):
        clock.advance(TICK)
        now = clock.monotonic()
        engine.step(now, last)
        last = now
    events = [{k: v for k, v in e.items() if k != "mono"} for e in engine.events]
    telemetry = json.dumps(engine.snapshot(), sort_keys=True, default=str)
    return events, telemetry


class TestDeterministicEngine(unittest.TestCase):
    def test_same_clock_and_seed_give_the_same_show(self):
        first_events, first_telemetry = run_show()
        second_events, second_telemetry = run_show()
        self.assertEqual(first_events, second_events)
        self.assertEqual(first_telemetry, second_telemetry)

    def test_the_run_does_real_work(self):
        events, _ = run_show()
        self.assertGreater(len(events), 0)
        self.assertTrue(any(e["kind"] != "system" for e in events), events[:3])

    def test_manual_clock_never_sleeps_for_real(self):
        clock = ManualClock()
        clock.sleep(2.5)
        self.assertAlmostEqual(clock.monotonic(), 2.5)
        self.assertAlmostEqual(clock.time(), 2.5)
        self.assertEqual(clock.hhmmss(), "00:00:02")


if __name__ == "__main__":
    unittest.main()
