/**
 * The connective tissue of a body on the bridge: the same discs, beads and cartilage the
 * overlay draws for a run of our own, built from somebody else's poses.
 *
 * A followed body is bones and belly rings and nothing else, so the tissue has to come from the
 * publisher's status: a table of frames in bone names (`tissueTable` in `tissue.ts`), which is
 * static for a run and small enough to ride along with the status. Given that and a pose, every
 * shape is placed the way the overlay places its own -- a disc or a bead rigid in one bone, a
 * bar of cartilage between points in two -- so a training run watched from here shows what a run
 * of our own shows. The headset does the same thing in `apps/xr-viewer/src/tissue.rs`.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { BEAD_RADIUS, DISC_HEIGHT, DISC_RADIUS, type TissueTable } from './tissue.js';

/** A shape rigid in one bone: which bone, and where it sits in it. */
interface Rigid {
  readonly bone: number;
  readonly mesh: Mesh;
  readonly offset: Vector3;
  readonly turn: Quaternion;
}

/** A bar of cartilage: a point in each of two bones. */
interface Bar {
  readonly boneA: number;
  readonly onA: Vector3;
  readonly boneB: number;
  readonly onB: Vector3;
}

const _position = new Vector3();
const _rotation = new Quaternion();
const _point = new Vector3();

export class FollowTissue {
  readonly root = new Group();
  private readonly rigid: Rigid[] = [];
  private readonly bars: Bar[] = [];
  private readonly discGeometry = new CylinderGeometry(DISC_RADIUS, DISC_RADIUS, DISC_HEIGHT, 16);
  private readonly beadGeometry = new SphereGeometry(BEAD_RADIUS, 8, 6);
  private readonly discMaterial = new MeshBasicMaterial({
    color: 0x9fe3d8,
    transparent: true,
    opacity: 0.85,
  });
  private readonly barMaterial = new LineBasicMaterial({ color: 0xf7c59f });
  private readonly barPositions: Float32Array;
  private readonly barGeometry = new BufferGeometry();

  /** `bones` is the pose's own order; a frame naming a bone it has not got is left out. */
  constructor(table: TissueTable, bones: readonly string[]) {
    const index = new Map(bones.map((id, i) => [id, i]));
    for (const disc of table.discs) {
      const bone = index.get(disc.bone);
      if (bone === undefined) continue;
      const mesh = new Mesh(
        disc.kind === 'bead' ? this.beadGeometry : this.discGeometry,
        this.discMaterial,
      );
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.rigid.push({
        bone,
        mesh,
        offset: new Vector3(disc.position[0], disc.position[1], disc.position[2]),
        turn: new Quaternion(
          disc.rotation[0],
          disc.rotation[1],
          disc.rotation[2],
          disc.rotation[3],
        ),
      });
    }
    for (const bar of table.bars) {
      const boneA = index.get(bar.boneA);
      const boneB = index.get(bar.boneB);
      if (boneA === undefined || boneB === undefined) continue;
      this.bars.push({
        boneA,
        onA: new Vector3(bar.localA[0], bar.localA[1], bar.localA[2]),
        boneB,
        onB: new Vector3(bar.localB[0], bar.localB[1], bar.localB[2]),
      });
    }
    this.barPositions = new Float32Array(Math.max(1, this.bars.length) * 6);
    this.barGeometry.setAttribute('position', new BufferAttribute(this.barPositions, 3));
    this.barGeometry.setDrawRange(0, this.bars.length * 2);
    const lines = new LineSegments(this.barGeometry, this.barMaterial);
    lines.frustumCulled = false;
    this.root.add(lines);
  }

  /** Place every shape from a pose: `position` 3 a bone, `orientation` 4, in the pose's order. */
  update(position: ArrayLike<number>, orientation: ArrayLike<number>): void {
    for (const shape of this.rigid) {
      const b = shape.bone;
      _position.set(position[3 * b] ?? 0, position[3 * b + 1] ?? 0, position[3 * b + 2] ?? 0);
      _rotation.set(
        orientation[4 * b] ?? 0,
        orientation[4 * b + 1] ?? 0,
        orientation[4 * b + 2] ?? 0,
        orientation[4 * b + 3] ?? 1,
      );
      shape.mesh.position.copy(shape.offset).applyQuaternion(_rotation).add(_position);
      shape.mesh.quaternion.copy(_rotation).multiply(shape.turn);
    }
    let at = 0;
    for (const bar of this.bars) {
      for (const [bone, local] of [
        [bar.boneA, bar.onA],
        [bar.boneB, bar.onB],
      ] as const) {
        _position.set(
          position[3 * bone] ?? 0,
          position[3 * bone + 1] ?? 0,
          position[3 * bone + 2] ?? 0,
        );
        _rotation.set(
          orientation[4 * bone] ?? 0,
          orientation[4 * bone + 1] ?? 0,
          orientation[4 * bone + 2] ?? 0,
          orientation[4 * bone + 3] ?? 1,
        );
        _point.copy(local).applyQuaternion(_rotation).add(_position);
        this.barPositions[at++] = _point.x;
        this.barPositions[at++] = _point.y;
        this.barPositions[at++] = _point.z;
      }
    }
    this.barGeometry.getAttribute('position').needsUpdate = true;
  }

  /** Free the geometry and leave the scene: whoever added it need not remember where. */
  dispose(): void {
    this.root.removeFromParent();
    this.discGeometry.dispose();
    this.beadGeometry.dispose();
    this.discMaterial.dispose();
    this.barGeometry.dispose();
    this.barMaterial.dispose();
  }
}
