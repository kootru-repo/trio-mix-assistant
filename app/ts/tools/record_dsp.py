import numpy as np
from fixture_util import f32, f64, num, write

from trio_mix import config as C
from trio_mix import dsp

SR = C.SAMPLE_RATE


def tone(freq, n=1024, amp=0.3, phase=0.0):
    t = np.arange(n) / SR
    return amp * np.sin(2 * np.pi * freq * t + phase)


def noise(seed, n=1024, amp=0.01):
    return amp * np.random.default_rng(seed).standard_normal(n)


def analyse_cases():
    cases = {
        "noise": noise(1),
        "sine_1k": tone(1000) + noise(2),
        "ring_2500": tone(2500, amp=0.2) + noise(3),
        "ring_200": tone(200, amp=0.2) + noise(4),
        "harmonic_rich": tone(440) + tone(880, amp=0.25) + tone(1320, amp=0.2) + noise(5),
        "silence": np.zeros(1024),
        "short_15": noise(6, n=15),
        "loud_clip": np.clip(tone(700, amp=2.0), -1, 1),
    }
    out = []
    for name, x in cases.items():
        x = x.astype("float32")
        f = dsp.analyse_block(x)
        out.append(
            {
                "name": name,
                "input": f32(x),
                "rms_dbfs": num(f.rms_dbfs),
                "peak_dbfs": num(f.peak_dbfs),
                "fb_freq": num(f.fb_freq),
                "contrast_db": num(f.contrast_db),
                "harmonicity": num(f.harmonicity),
                "spectrum": f64(f.spectrum),
            }
        )
    empty = dsp.analyse_block(np.zeros(0, dtype="float32"))
    out.append(
        {
            "name": "empty",
            "input": "",
            "rms_dbfs": empty.rms_dbfs,
            "peak_dbfs": empty.peak_dbfs,
            "fb_freq": None,
            "contrast_db": 0.0,
            "harmonicity": 0.0,
            "spectrum": "",
        }
    )
    return out


def rolling_cases():
    det = dsp.RollingRingDetector()
    blocks = []
    results = []
    for i in range(8):
        ring = tone(300, amp=0.25, phase=i * 0.7) if i >= 2 else 0.0
        blk = (ring + noise(100 + i)).astype("float32")
        blocks.append(blk)
        fb, h = det.update(blk)
        results.append({"fb": num(fb), "h": num(h)})
    return {"blocks": f32(np.concatenate(blocks)), "block_len": 1024, "results": results}


def phase_cases():
    base = noise(20, amp=0.2)
    delayed = np.concatenate([np.zeros(10), base[:-10]])
    cases = {
        "identical": (base, base),
        "inverted": (base, -base),
        "delayed_10": (base, delayed),
        "unrelated": (base, noise(21, amp=0.2)),
        "silence": (np.zeros(1024), base),
        "short": (base[:10], base[:10]),
        "sine_inverted": (tone(500), -tone(500)),
    }
    out = []
    for name, (a, b) in cases.items():
        a = a.astype("float32")
        b = b.astype("float32")
        r = dsp.phase_relation(a, b)
        out.append(
            {
                "name": name,
                "a": f32(a),
                "b": f32(b),
                "zero_corr": r.zero_corr,
                "best_corr": r.best_corr,
                "lag_samples": r.lag_samples,
                "lag_ms": r.lag_ms,
            }
        )
    return out


def band_cases():
    n = 49152
    rng = np.random.default_rng(30)
    pink = dsp.generate_pink_noise(n / SR, rng=rng)
    t = np.arange(n) / SR
    captured = (
        pink + 0.30 * np.sin(2 * np.pi * 250.0 * t) + 0.22 * np.sin(2 * np.pi * 2500.0 * t)
    ).astype("float32")
    bands = dsp.octave_band_levels(captured)
    corrections, watch = dsp.find_resonant_peaks(captured)
    flat = pink.astype("float32")
    flat_corr, flat_watch = dsp.find_resonant_peaks(flat)
    pn = dsp.generate_pink_noise(2.0, rng=np.random.default_rng(31))
    pb = dsp.octave_band_levels(pn)
    fcs = list(pb)
    slope = float(np.polyfit(np.log2(fcs[1:8]), [pb[f] for f in fcs[1:8]], 1)[0])
    return {
        "captured": f32(captured),
        "bands": [[k, v] for k, v in bands.items()],
        "corrections": [list(x) for x in corrections],
        "watchlist": [list(x) for x in watch],
        "flat_corrections": [list(x) for x in flat_corr],
        "flat_watchlist": [list(x) for x in flat_watch],
        "pink": {
            "seconds": 2.0,
            "peak": float(np.max(np.abs(pn))),
            "slope_db_per_octave": slope,
            "n": int(pn.size),
        },
    }


if __name__ == "__main__":
    write(
        "dsp",
        {
            "analyse": analyse_cases(),
            "rolling": rolling_cases(),
            "phase": phase_cases(),
            "bands": band_cases(),
        },
    )
