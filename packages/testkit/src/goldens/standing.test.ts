import { pinScenarios } from '../goldenSuite.js';

// The four standing scenarios: the ankle strategy, the standing and walking clips, and the trained
// standing policy. goldenSuite.ts has the checks; each file under goldens/ is one group, so vitest
// steps the groups side by side.
pinScenarios('standing');
