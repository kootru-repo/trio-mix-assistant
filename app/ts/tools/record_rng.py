import numpy as np
from fixture_util import f64, write

SEEDS = [0, 7, 30, 31, 123456789, 2**40 + 5, 2**64 - 1]


def main():
    out = []
    for seed in SEEDS:
        g = np.random.default_rng(seed)
        doubles = g.random(40)
        g = np.random.default_rng(seed)
        normals = g.standard_normal(5000)
        g = np.random.default_rng(seed)
        grid = g.standard_normal((6, 7))
        out.append(
            {
                "seed": str(seed),
                "random": f64(doubles),
                "normal": f64(normals),
                "grid": f64(grid.reshape(-1)),
            }
        )
    write("rng", out)


if __name__ == "__main__":
    main()
