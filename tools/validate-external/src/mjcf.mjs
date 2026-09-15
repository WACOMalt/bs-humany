/**
 * Just enough MJCF to read a reference model.
 *
 * Not a parser for the format: a reader for the handful of things the comparison needs, which
 * are the nesting of `<body>`, the `<joint>` elements inside each, and the `<joint>` equality
 * constraints. MJCF files in the wild carry comments, self-closing tags and attributes in any
 * order, and all of that is handled; anything else is ignored rather than rejected, because this
 * reads a file somebody else maintains and a new attribute there is not our error.
 *
 * A commented-out element is *not* read, which matters: the head model's neck joints are
 * commented out upstream, and a reader that ignored comments would report them as present.
 */

/** Strip comments, then walk tags in order. */
export function readMjcf(xml) {
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  const bodies = [];
  const equalities = [];
  const stack = [];
  const tag = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let match = tag.exec(text);
  while (match) {
    const [, closing, name, rawAttributes, selfClosing] = match;
    const attributes = parseAttributes(rawAttributes ?? '');
    if (closing) {
      if (name === 'body') stack.pop();
    } else if (name === 'body') {
      const body = {
        name: attributes.name ?? `body${bodies.length}`,
        pos: numbers(attributes.pos, 3) ?? [0, 0, 0],
        euler: numbers(attributes.euler, 3),
        quat: numbers(attributes.quat, 4),
        parent: stack.length > 0 ? (stack[stack.length - 1] ?? null) : null,
        joints: [],
      };
      bodies.push(body);
      if (!selfClosing) stack.push(body.name);
    } else if (name === 'joint') {
      if (attributes.joint1 !== undefined || attributes.polycoef !== undefined) {
        // Inside <equality>: a joint-to-joint constraint, not a degree of freedom.
        equalities.push({
          name: attributes.name ?? '',
          joint1: attributes.joint1 ?? '',
          joint2: attributes.joint2 ?? '',
          polycoef: numbers(attributes.polycoef, 5) ?? [0, 0, 0, 0, 0],
        });
      } else if (attributes.name) {
        const host = stack.length > 0 ? stack[stack.length - 1] : undefined;
        const body = bodies.find((b) => b.name === host);
        if (body) {
          body.joints.push({
            name: attributes.name,
            axis: numbers(attributes.axis, 3) ?? [0, 0, 1],
            range: numbers(attributes.range, 2),
            type: attributes.type ?? 'hinge',
            body: body.name,
          });
        }
      }
    }
    match = tag.exec(text);
  }
  return { bodies, equalities };
}

function parseAttributes(raw) {
  const out = {};
  const attribute = /([\w.:-]+)\s*=\s*"([^"]*)"/g;
  let match = attribute.exec(raw);
  while (match) {
    out[match[1]] = match[2];
    match = attribute.exec(raw);
  }
  return out;
}

function numbers(value, count) {
  if (value === undefined) return undefined;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== count || parts.some((n) => !Number.isFinite(n))) return undefined;
  return parts;
}

/** Every joint in the model, by name. */
export function jointsByName(model) {
  const out = new Map();
  for (const body of model.bodies) for (const joint of body.joints) out.set(joint.name, joint);
  return out;
}

/** Equality constraints by name. */
export function equalitiesByName(model) {
  return new Map(model.equalities.map((e) => [e.name, e]));
}

/** Distance from a body to its parent, which for these models is the segment's own length. */
export function bodyOffset(model, name) {
  const body = model.bodies.find((b) => b.name === name);
  if (!body) return undefined;
  return Math.hypot(body.pos[0], body.pos[1], body.pos[2]);
}

/** Angle between two direction vectors, radians. */
export function angleBetween(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  if (la === 0 || lb === 0) return Number.NaN;
  return Math.acos(Math.max(-1, Math.min(1, dot / (la * lb))));
}
