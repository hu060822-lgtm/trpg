/** Returns an integer in [1, sides]. Injected so checks are reproducible in tests and replays. */
export type Rng = (sides: number) => number;

export const randomRng: Rng = (sides) => {
  const buf = new Uint32Array(1);
  // Rejection sampling avoids modulo bias.
  const limit = Math.floor(0x100000000 / sides) * sides;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return (buf[0] % sides) + 1;
};

/** Replays a fixed sequence of rolls; throws if it runs out. */
export function scriptedRng(values: number[]): Rng {
  let i = 0;
  return (sides) => {
    if (i >= values.length) throw new Error('scriptedRng exhausted');
    const v = values[i++];
    if (v < 1 || v > sides) throw new Error(`scripted roll ${v} out of range 1..${sides}`);
    return v;
  };
}
