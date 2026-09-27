import { pinScenarios } from '../goldenSuite.js';

// The L1 skeleton scenarios -- the drops, the stairs, the hang, the seat and the swing -- with the
// skull shake and the tilting floor. goldenSuite.ts has the checks; each file under goldens/ is
// one group, so vitest steps the groups side by side.
pinScenarios('skeleton');
