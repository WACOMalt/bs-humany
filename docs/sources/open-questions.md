# Open source questions

Parameters that could not be derived from a citable source. Recorded here rather than invented or
copied from a reference oracle, per ADR-009 and CONTRIBUTING rules 4 and 5.

Each entry names what is missing, what is being used provisionally, and what would close it.

## Format

```
### OQ-nnn — short title
**Needed for:** ticket or package
**Provisional value:** what is in the code right now, and why it is defensible
**Closes when:** the specific source or measurement that would resolve it
**Status:** open | closed (commit)
```

---

### OQ-001 — de Leva (1996) Table 4 not yet verified against the source document
**Needed for:** `@bs-humany/anthropometry`, `deleva.ts`
**Provisional value:** The full male and female tables are transcribed and pass every automated
consistency check available: segment masses sum to 1.000 of body mass for both sexes, the three
trunk sub-segments decompose the trunk entry to four decimal places, every centre of mass falls
inside its segment, every radius of gyration is positive and below unity, and every derived inertia
tensor satisfies the triangle inequality at every sex-blend value. Directional dimorphism checks
also pass, which rules out a wholesale swap of the two tables.

Those checks catch a transposed digit that breaks an invariant. They **cannot** catch a value that
is internally consistent and simply not what the paper says.

**Closes when:** a human reads de Leva (1996) Table 4 and checks the 99 transcribed values line by
line, recording the check in `docs/validation/`. Then set `DE_LEVA_PROVENANCE.status` to
`'verified'`.
**Status:** open

### OQ-002 — ANSUR II reference statistics not yet verified against the source document
**Needed for:** `@bs-humany/anthropometry`, `ansur.ts`
**Provisional value:** 50th-percentile stature and body mass, and their standard deviations, for
each sex. Consistency-checked against published BMI ranges for the ANSUR II sample and against the
requirement that percentile scaling be monotonic.
**Closes when:** a human checks the values against Gordon et al. (2014) summary statistics tables.
**Status:** open

### OQ-003 — Segment-length proportions are not sex-separated
**Needed for:** `@bs-humany/anthropometry`, `ansur.ts`
**Provisional value:** Drillis & Contini (1966) fractions of stature, applied identically to both
endpoint tables. ANSUR II measures stature, weight and several breadths directly and
sex-separately, but does not publish most segment lengths as such, so the proportions come from a
source that is not sex-separated.

This understates real dimorphism in limb proportion -- notably the crural and brachial indices, and
relative leg length. The `proportions` overrides in `Morphology` exist so a user can correct for it
explicitly, but the defaults are currently sex-neutral and the model should say so rather than
implying a dimorphism it does not have.

**Closes when:** sex-separated segment-length proportions are derived from a citable published
source, or from ANSUR II's own 3D scan data.
**Status:** open
