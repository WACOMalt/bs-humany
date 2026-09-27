import { pinScenarios } from '../goldenSuite.js';

// The two flailing scenarios: the elbows driven by sine waves, and the clip. goldenSuite.ts has
// the checks; each file under goldens/ is one group, so vitest steps the groups side by side.
pinScenarios('flail');
