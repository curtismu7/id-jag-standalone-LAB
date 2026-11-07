/**
 * Test timeout for the pure-CPU sweeps (diagram label placement, diagram geometry).
 *
 * Not 0 (no limit): that gives a hung run no bound at all. Not the old 30-120 s either: vitest compares a synchronous test's wall time with its
 * limit once it ends, so a slow-but-correct run on a loaded machine failed. Measured, the longest sweep takes about 10 s here (byo drag sweep,
 * load ~30) and every other one under 2 s; this is 600 s, 60 times the longest, which is far beyond any slowdown seen (the earlier failures came at
 * 7x) and still ends a run that is really stuck. A synchronous loop cannot be interrupted by any test timeout; the sweeps that yield to the
 * event loop between steps (idJagLabelPlacement.drag.test.js) are the ones this limit can actually stop.
 */
export const SWEEP_TIMEOUT_MS = 600000;
