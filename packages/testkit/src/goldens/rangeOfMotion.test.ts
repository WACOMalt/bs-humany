import { pinScenarios } from '../goldenSuite.js';

// The muscle range of motion alone: fourteen seconds of the whole muscle set at a kilohertz, the
// longest single run. goldenSuite.ts has the checks; each file under goldens/ is one group, so
// vitest steps the groups side by side.
pinScenarios('rangeOfMotion');
