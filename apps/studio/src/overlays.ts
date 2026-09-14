/**
 * Debug overlays -- milestone M3.13, spec section 11.
 *
 * Each overlay is a pure view of a channel: proxies and centres of mass follow `body.pose`,
 * joint axes follow the parent segment's pose and colour themselves by `diagnostics.limits`,
 * contacts draw `contact.manifolds`. Nothing here talks to the backend, so what is drawn is
 * exactly what every other consumer of the channels sees.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Points,
  PointsMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';

export interface OverlayChannels {
  readonly position: Float64Array;
  readonly orientation: Float64Array;
  readonly proximity: Float64Array;
  readonly contactCount: number;
  readonly contactPoint: Float64Array;
  readonly contactNormal: Float64Array;
  readonly contactCapacity: number;
}

export interface Overlays {
  readonly root: Group;
  readonly proxies: Group;
  readonly axes: Group;
  readonly com: Group;
  readonly contacts: Group;
  update(channels: OverlayChannels): void;
  dispose(): void;
}

const AXIS_LENGTH = 0.06;
const NORMAL_LENGTH = 0.05;
const ONE = new Vector3(1, 1, 1);
const _position = new Vector3();
const _rotation = new Quaternion();
const _matrix = new Matrix4();
const _cold = new Color(0x3ddc84);
const _hot = new Color(0xff3b30);
const _tint = new Color();

export function createOverlays(model: CompiledArticulation): Overlays {
  const root = new Group();
  const proxies = new Group();
  const axes = new Group();
  const com = new Group();
  const contacts = new Group();
  root.add(proxies, axes, com, contacts);

  // --- Proxies: one wireframe per segment, children placed at the proxy transform -------------
  const proxyMaterial = new MeshBasicMaterial({
    color: 0x6aa9ff,
    wireframe: true,
    transparent: true,
    opacity: 0.55,
  });
  const segmentNodes: Object3D[] = model.segments.map(() => {
    const node = new Object3D();
    node.matrixAutoUpdate = false;
    proxies.add(node);
    return node;
  });
  for (const proxy of model.proxies) {
    const shape = proxy.shape;
    let geometry: BufferGeometry;
    if (shape.kind === 'capsule') geometry = new CapsuleGeometry(shape.radius, shape.length, 4, 12);
    else if (shape.kind === 'sphere') geometry = new SphereGeometry(shape.radius, 12, 8);
    else if (shape.kind === 'box')
      geometry = new BoxGeometry(
        2 * shape.halfExtents.x,
        2 * shape.halfExtents.y,
        2 * shape.halfExtents.z,
      );
    else geometry = new ConvexGeometry(shape.vertices.map((v) => new Vector3(v.x, v.y, v.z)));
    const mesh = new Mesh(geometry, proxyMaterial);
    const t = proxy.transform;
    mesh.position.set(t.translation.x, t.translation.y, t.translation.z);
    mesh.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
    segmentNodes[proxy.segment]?.add(mesh);
  }

  // --- Joint axes: one line per DoF, in the joint frame, coloured by end-range proximity ------
  const axisPositions = new Float32Array(model.dofs.length * 6);
  const axisColors = new Float32Array(model.dofs.length * 6);
  const axisGeometry = new BufferGeometry();
  axisGeometry.setAttribute('position', new BufferAttribute(axisPositions, 3));
  axisGeometry.setAttribute('color', new BufferAttribute(axisColors, 3));
  const axisLines = new LineSegments(axisGeometry, new LineBasicMaterial({ vertexColors: true }));
  axisLines.frustumCulled = false;
  axes.add(axisLines);
  const jointMarkers = model.joints.map(() => {
    const marker = new Mesh(
      new SphereGeometry(0.012, 8, 6),
      new MeshBasicMaterial({ color: 0xffd166 }),
    );
    axes.add(marker);
    return marker;
  });

  // --- Centres of mass ------------------------------------------------------------------------
  const comMaterial = new MeshBasicMaterial({ color: 0xff9f43 });
  const comMarkers = model.segments.map((s) => {
    const marker = new Mesh(
      new SphereGeometry(0.01 + 0.01 * Math.cbrt(s.mass / 10), 8, 6),
      comMaterial,
    );
    com.add(marker);
    return marker;
  });
  const bodyCom = new Mesh(
    new SphereGeometry(0.03, 12, 8),
    new MeshBasicMaterial({ color: 0xffffff, wireframe: true }),
  );
  com.add(bodyCom);

  // --- Contacts -------------------------------------------------------------------------------
  const contactCapacity = 256;
  const contactPositions = new Float32Array(contactCapacity * 3);
  const contactGeometry = new BufferGeometry();
  contactGeometry.setAttribute('position', new BufferAttribute(contactPositions, 3));
  contactGeometry.setDrawRange(0, 0);
  const contactPoints = new Points(
    contactGeometry,
    new PointsMaterial({ color: 0xff3b30, size: 0.02 }),
  );
  contactPoints.frustumCulled = false;
  const normalPositions = new Float32Array(contactCapacity * 6);
  const normalGeometry = new BufferGeometry();
  normalGeometry.setAttribute('position', new BufferAttribute(normalPositions, 3));
  normalGeometry.setDrawRange(0, 0);
  const normalLines = new LineSegments(normalGeometry, new LineBasicMaterial({ color: 0xff8a80 }));
  normalLines.frustumCulled = false;
  contacts.add(contactPoints, normalLines);

  const jointOrigin = new Vector3();
  const jointRotation = new Quaternion();
  const axisVector = new Vector3();

  return {
    root,
    proxies,
    axes,
    com,
    contacts,
    update(ch) {
      const total = model.totalMass;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      model.segments.forEach((s, i) => {
        _position.set(
          ch.position[3 * i] ?? 0,
          ch.position[3 * i + 1] ?? 0,
          ch.position[3 * i + 2] ?? 0,
        );
        _rotation.set(
          ch.orientation[4 * i] ?? 0,
          ch.orientation[4 * i + 1] ?? 0,
          ch.orientation[4 * i + 2] ?? 0,
          ch.orientation[4 * i + 3] ?? 1,
        );
        if (proxies.visible) {
          const node = segmentNodes[i];
          if (node) node.matrix.compose(_position, _rotation, ONE);
        }
        if (com.visible) {
          axisVector.set(s.com.x, s.com.y, s.com.z).applyQuaternion(_rotation).add(_position);
          comMarkers[i]?.position.copy(axisVector);
          cx += (axisVector.x * s.mass) / total;
          cy += (axisVector.y * s.mass) / total;
          cz += (axisVector.z * s.mass) / total;
        }
      });
      if (com.visible) bodyCom.position.set(cx, cy, cz);

      if (axes.visible) {
        model.joints.forEach((joint, k) => {
          const p = joint.parentSegment;
          _position.set(
            ch.position[3 * p] ?? 0,
            ch.position[3 * p + 1] ?? 0,
            ch.position[3 * p + 2] ?? 0,
          );
          _rotation.set(
            ch.orientation[4 * p] ?? 0,
            ch.orientation[4 * p + 1] ?? 0,
            ch.orientation[4 * p + 2] ?? 0,
            ch.orientation[4 * p + 3] ?? 1,
          );
          const f = joint.frameInParent;
          jointOrigin
            .set(f.translation.x, f.translation.y, f.translation.z)
            .applyQuaternion(_rotation)
            .add(_position);
          jointRotation
            .set(f.rotation.x, f.rotation.y, f.rotation.z, f.rotation.w)
            .premultiply(_rotation);
          jointMarkers[k]?.position.copy(jointOrigin);
          for (const dof of joint.dofs) {
            axisVector
              .set(dof.vector.x, dof.vector.y, dof.vector.z)
              .applyQuaternion(jointRotation)
              .multiplyScalar(AXIS_LENGTH);
            const o = 6 * dof.index;
            axisPositions[o] = jointOrigin.x;
            axisPositions[o + 1] = jointOrigin.y;
            axisPositions[o + 2] = jointOrigin.z;
            axisPositions[o + 3] = jointOrigin.x + axisVector.x;
            axisPositions[o + 4] = jointOrigin.y + axisVector.y;
            axisPositions[o + 5] = jointOrigin.z + axisVector.z;
            _tint.copy(_cold).lerp(_hot, Math.min(1, Math.max(0, ch.proximity[dof.index] ?? 0)));
            axisColors[o] = _tint.r;
            axisColors[o + 1] = _tint.g;
            axisColors[o + 2] = _tint.b;
            axisColors[o + 3] = _tint.r;
            axisColors[o + 4] = _tint.g;
            axisColors[o + 5] = _tint.b;
          }
        });
        axisGeometry.getAttribute('position').needsUpdate = true;
        axisGeometry.getAttribute('color').needsUpdate = true;
      }

      if (contacts.visible) {
        const n = Math.min(ch.contactCount, ch.contactCapacity, contactCapacity);
        for (let i = 0; i < n; i++) {
          const px = ch.contactPoint[3 * i] ?? 0;
          const py = ch.contactPoint[3 * i + 1] ?? 0;
          const pz = ch.contactPoint[3 * i + 2] ?? 0;
          contactPositions[3 * i] = px;
          contactPositions[3 * i + 1] = py;
          contactPositions[3 * i + 2] = pz;
          normalPositions[6 * i] = px;
          normalPositions[6 * i + 1] = py;
          normalPositions[6 * i + 2] = pz;
          normalPositions[6 * i + 3] = px + (ch.contactNormal[3 * i] ?? 0) * NORMAL_LENGTH;
          normalPositions[6 * i + 4] = py + (ch.contactNormal[3 * i + 1] ?? 0) * NORMAL_LENGTH;
          normalPositions[6 * i + 5] = pz + (ch.contactNormal[3 * i + 2] ?? 0) * NORMAL_LENGTH;
        }
        contactGeometry.setDrawRange(0, n);
        normalGeometry.setDrawRange(0, 2 * n);
        contactGeometry.getAttribute('position').needsUpdate = true;
        normalGeometry.getAttribute('position').needsUpdate = true;
      }
      _matrix.identity();
    },
    dispose() {
      root.traverse((o) => {
        if (o instanceof Mesh || o instanceof LineSegments || o instanceof Points)
          o.geometry.dispose();
      });
      root.removeFromParent();
    },
  };
}
