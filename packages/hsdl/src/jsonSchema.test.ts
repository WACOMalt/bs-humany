import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { makeMinimalDocument } from './fixtures.js';
import { generateJsonSchema } from './jsonSchema.js';
import { HSDL_VERSION, SCHEMA_BASE_URI } from './namespace.js';
import { validateDocument } from './validate.js';

/**
 * The generated JSON Schema and the Zod schema are supposed to be two views of one definition.
 * Nothing enforces that except these tests. Without them a generation bug -- a recursive $ref
 * emitted wrong, say -- would go unnoticed until an external consumer tried to use the schema.
 */

function compile() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  return ajv.compile(generateJsonSchema());
}

describe('generated JSON Schema', () => {
  it('is a well-formed draft 2020-12 schema that Ajv can compile', () => {
    expect(() => compile()).not.toThrow();
  });

  it('carries the project reverse-DNS $id', () => {
    const schema = generateJsonSchema();
    expect(schema.$id).toBe(`${SCHEMA_BASE_URI}/hsdl-${HSDL_VERSION}.json`);
  });

  it('names its reusable definitions rather than numbering them', () => {
    const defs = (generateJsonSchema().$defs ?? {}) as Record<string, unknown>;
    for (const name of ['ScalarExpr', 'BoneDef', 'JointDef', 'GeometryRecipe', 'Citation']) {
      expect(Object.keys(defs)).toContain(name);
    }
  });

  it('accepts the same document Zod accepts', () => {
    const doc = JSON.parse(JSON.stringify(makeMinimalDocument()));
    expect(validateDocument(doc).ok).toBe(true);

    const validate = compile();
    const valid = validate(doc);
    if (!valid) {
      throw new Error(
        'The generated schema rejected a document Zod accepts. This means the two have ' +
          `drifted:\n${JSON.stringify(validate.errors, null, 2)}`,
      );
    }
    expect(valid).toBe(true);
  });

  it('rejects the same documents Zod rejects', () => {
    const validate = compile();

    const wrongVersion = JSON.parse(JSON.stringify(makeMinimalDocument()));
    wrongVersion.hsdlVersion = '0.2';
    expect(validate(wrongVersion)).toBe(false);
    expect(validateDocument(wrongVersion).ok).toBe(false);

    const missingBones = JSON.parse(JSON.stringify(makeMinimalDocument()));
    missingBones.bones = [];
    expect(validate(missingBones)).toBe(false);
    expect(validateDocument(missingBones).ok).toBe(false);

    const unknownKey = JSON.parse(JSON.stringify(makeMinimalDocument()));
    unknownKey.collisionProxys = [];
    expect(validate(unknownKey)).toBe(false);
    expect(validateDocument(unknownKey).ok).toBe(false);
  });

  it('handles the recursive ScalarExpr definition', () => {
    // ScalarExpr and GeometryRecipe are self-referential. If they were inlined rather than
    // emitted as $refs, generation would not terminate; if the $ref were wrong, deeply nested
    // expressions would fail to validate. This checks the depth actually resolves.
    const validate = compile();
    const doc = JSON.parse(JSON.stringify(makeMinimalDocument()));
    doc.bones[1].dimensions.nested = {
      blend: [{ mul: [0.25, { param: 'stature' }] }, { add: [{ param: 'mass' }, 1] }],
    };
    expect(validateDocument(doc).ok).toBe(true);
    expect(validate(doc)).toBe(true);
  });

  it('is deterministic, so the committed artifact does not churn', () => {
    expect(JSON.stringify(generateJsonSchema())).toBe(JSON.stringify(generateJsonSchema()));
  });
});
