const TWO52 = 1n << 52n;

function exactParts(x: number): { mant: bigint; exp: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const e = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & (TWO52 - 1n);
  if (e === 0) return { mant: frac, exp: -1074 };
  return { mant: frac | TWO52, exp: e - 1075 };
}

export function fixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x < 0 ? "-inf" : "inf";
  const { mant, exp } = exactParts(x);
  if (mant !== 0n && exp < 0) {
    const denom = 1n << BigInt(-exp);
    const scaled = mant * 10n ** BigInt(digits);
    if ((scaled * 2n) % denom === 0n && ((scaled * 2n) / denom) % 2n === 1n) {
      const floor = scaled / denom;
      const even = floor % 2n === 0n ? floor : floor + 1n;
      let s = even.toString().padStart(digits + 1, "0");
      if (digits > 0) s = s.slice(0, s.length - digits) + "." + s.slice(s.length - digits);
      return (x < 0 ? "-" : "") + s;
    }
  }
  const out = x.toFixed(digits);
  return Object.is(x, -0) && !out.startsWith("-") ? "-" + out : out;
}

export const signed = (x: number, digits: number): string => {
  const s = fixed(x, digits);
  return s.startsWith("-") ? s : "+" + s;
};

export const percent = (x: number, digits: number = 0): string => fixed(x * 100, digits) + "%";

export const pyRound = (x: number): number => Number(fixed(x, 0)) + 0;

export const pyRoundTo = (x: number, digits: number): number => Number(fixed(x, digits));
