import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/* ── bbmodel format ─────────────────────────────────────────────────────
 * Only the fields this loader actually reads. Blockbench's full schema is
 * much larger; unknown fields are simply carried past.
 * -------------------------------------------------------------------- */

type Vec3 = [number, number, number];

interface BBTexture {
  name?: string;
  source?: string;
  width?: number;
  height?: number;
  uv_width?: number;
  uv_height?: number;
  frame_time?: number;
}

interface BBFace {
  uv: [number, number, number, number];
  texture?: number | string | null;
  rotation?: number;
}

interface BBElement {
  name?: string;
  uuid?: string;
  /** "cube" (default) or "mesh". */
  type?: string;
  /** Cuboid elements carry from/to; mesh elements carry `vertices` instead. */
  from?: Vec3;
  to?: Vec3;
  vertices?: Record<string, Vec3>;
  origin?: Vec3;
  rotation?: Vec3;
  faces?: Record<string, BBFace | undefined>;
  visibility?: boolean;
}

/**
 * A group. Newer bbmodel files keep these in a top-level `groups` array, while
 * older ones inline the same fields directly on the outliner node — so the two
 * shapes are modelled as one.
 */
interface BBGroup {
  name?: string;
  uuid: string;
  origin?: Vec3;
  rotation?: Vec3;
  visibility?: boolean;
  children?: BBOutlinerNode[];
}

type BBOutlinerNode = string | BBGroup;

interface BBKeyframe {
  channel: string;
  time: number;
  data_points: Array<{ x?: number | string; y?: number | string; z?: number | string }>;
}

interface BBAnimation {
  name: string;
  length?: number;
  animators?: Record<string, { keyframes?: BBKeyframe[] }>;
}

export interface BBModel {
  name?: string;
  resolution?: { width: number; height: number };
  textures?: BBTexture[];
  elements?: BBElement[];
  groups?: BBGroup[];
  outliner?: BBOutlinerNode[];
  animations?: BBAnimation[];
}

/* ── Scratch texture metadata ───────────────────────────────────────── */

interface TextureInfo {
  width: number;
  height: number;
  /** Width of the UV space the model's face coordinates are written in. */
  uvWidth: number;
  uvHeight: number;
  isAnimated?: boolean;
  frameCount?: number;
  currentFrame?: number;
  frameTime?: number;
  timeAccumulator?: number;
  tileHeight?: number;
}

function infoOf(texture: THREE.Texture): TextureInfo {
  return texture.userData as TextureInfo;
}

/* ── Types ──────────────────────────────────────────────────────────── */

export interface LoadResult {
  animations: string[];
  elements: number;
  textures: number;
  /** Elements that could not be drawn (mesh elements, malformed data). */
  skipped: number;
}

export interface ViewerOptions {
  /**
   * Maps a texture `source` that is not an inline data URI to a fetchable URL.
   * Models found on GitHub often reference sibling PNGs by relative path.
   */
  resolveTexture?: (source: string) => string;
  onError?: (error: Error) => void;
}

export interface ModelViewer {
  load: (jsonText: string) => Promise<LoadResult>;
  playAnimation: (name: string) => void;
  clear: () => void;
  resize: () => void;
  dispose: () => void;
}

const FACE_ORDER = ["east", "west", "up", "down", "south", "north"] as const;

/** True for a usable [x, y, z] triple — rejects undefined, wrong arity and NaN. */
function isFiniteVec3(value: unknown): value is Vec3 {
  return (
    Array.isArray(value) &&
    value.length >= 3 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Number.isFinite(value[2])
  );
}

/**
 * Blockbench stores animation values as strings, and editing a field can leave a
 * whitespace-only entry behind — this model's `body` rotation is `["-2", "0",
 * "\n\n"]`. `parseFloat("\n\n")` is NaN, and a single NaN rotation poisons the
 * quaternion and every descendant's world matrix, so whole limbs silently
 * vanish. Anything unparseable is treated as 0 (i.e. no change).
 */
function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = parseFloat(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Degrees → radians for an [x, y, z] triple, tolerating junk entries. */
function toRadians(value: unknown): THREE.Euler {
  const vec = Array.isArray(value) ? value : [0, 0, 0];
  return new THREE.Euler(
    THREE.MathUtils.degToRad(toNumber(vec[0])),
    THREE.MathUtils.degToRad(toNumber(vec[1])),
    THREE.MathUtils.degToRad(toNumber(vec[2])),
  );
}

interface RotationFrame {
  time: number;
  degrees: [number, number, number];
}

/**
 * Keeps every interpolated hop well under 180 degrees. A hop of 90 degrees of
 * body rotation is 45 degrees in quaternion space, so the dot product stays
 * firmly positive and three never has to pick a "shortest path" that reverses
 * the intended direction.
 */
const MAX_ROTATION_STEP_DEGREES = 90;

/**
 * Builds a quaternion track from Euler keyframes.
 *
 * Quaternion interpolation always takes the shortest arc, so a pair of keyframes
 * more than 180 degrees apart collapses to no movement at all — a `0 -> 360`
 * spin plays as a frozen part (Blockbench interpolates each Euler axis
 * linearly, so it spins). Walking the Euler path in small steps preserves the
 * full rotation while still landing exactly on each authored keyframe.
 */
function buildRotationTrack(
  name: string,
  frames: RotationFrame[],
): THREE.QuaternionKeyframeTrack | null {
  if (frames.length === 0) return null;

  const times: number[] = [];
  const values: number[] = [];

  const push = (time: number, degrees: [number, number, number]): void => {
    const quaternion = new THREE.Quaternion().setFromEuler(toRadians(degrees));
    times.push(time);
    values.push(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  };

  let previous: RotationFrame | null = null;

  for (const frame of frames) {
    const span = previous ? frame.time - previous.time : 0;

    // Equal timestamps cannot be subdivided without producing duplicate times,
    // which three rejects.
    if (previous && span > 0) {
      const delta = Math.max(
        Math.abs(frame.degrees[0] - previous.degrees[0]),
        Math.abs(frame.degrees[1] - previous.degrees[1]),
        Math.abs(frame.degrees[2] - previous.degrees[2]),
      );
      const steps = Math.ceil(delta / MAX_ROTATION_STEP_DEGREES);

      for (let step = 1; step < steps; step += 1) {
        const t = step / steps;
        push(previous.time + span * t, [
          previous.degrees[0] + (frame.degrees[0] - previous.degrees[0]) * t,
          previous.degrees[1] + (frame.degrees[1] - previous.degrees[1]) * t,
          previous.degrees[2] + (frame.degrees[2] - previous.degrees[2]) * t,
        ]);
      }
    }

    push(frame.time, frame.degrees);
    previous = frame;
  }

  return new THREE.QuaternionKeyframeTrack(name, times, values);
}

/* ── Model assembly ─────────────────────────────────────────────────── */

interface BuiltModel {
  root: THREE.Group;
  clips: THREE.AnimationClip[];
  animatedTextures: THREE.Texture[];
  elements: number;
  textures: number;
  /** Elements the loader could not represent (mesh elements, malformed data). */
  skipped: number;
}

function buildModel(
  bbmodel: BBModel,
  resolveTexture: (source: string) => string,
): BuiltModel {
  const textureLoader = new THREE.TextureLoader();

  const loadTexture = (source: string): THREE.Texture => {
    const url = source.startsWith("data:") ? source : resolveTexture(source);
    const texture = textureLoader.load(url);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  };

  /* 1. Textures — a vertically stacked sheet means an animated flipbook. */
  const animatedTextures: THREE.Texture[] = [];
  const resolution = bbmodel.resolution ?? { width: 16, height: 16 };

  const textures = (bbmodel.textures ?? []).map((entry) => {
    const texture = loadTexture(entry.source ?? "");
    const width = entry.width || entry.uv_width || resolution.width;
    const height = entry.height || entry.uv_height || resolution.height;
    // The UV space the model's face coordinates are written in. It normally
    // matches the image, but may be smaller — a 128x128 image with a 64x64 UV
    // space is still a single static texture, not a stack of frames.
    const uvWidth = entry.uv_width || width;
    const uvHeight = entry.uv_height || height;

    const info: TextureInfo = { width, height, uvWidth, uvHeight };
    texture.userData = info;

    // A flipbook is a *full-width* vertical strip: `frameCount` frames of
    // uvWidth x uvHeight stacked top to bottom. Requiring uvWidth === width is
    // what separates that from a texture whose UV space is simply smaller than
    // its image; without it the image gets sliced into bogus frames and the model
    // flickers between them.
    if (uvWidth === width && height > uvHeight && uvHeight > 0) {
      const frameCount = Math.floor(height / uvHeight);
      if (frameCount > 1) {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(1, 1 / frameCount);
        texture.offset.y = (frameCount - 1) / frameCount;

        info.isAnimated = true;
        info.frameCount = frameCount;
        info.currentFrame = 0;
        info.frameTime = (entry.frame_time || 1) * 50;
        info.timeAccumulator = 0;
        info.tileHeight = 1 / frameCount;

        animatedTextures.push(texture);
      }
    }
    return texture;
  });

  /* 2. Elements — one box per element, six materials in BoxGeometry order. */
  const elementObjects: Record<string, THREE.Object3D> = {};
  const elements = bbmodel.elements ?? [];
  let skipped = 0;

  /**
   * Rest rotation in degrees, per bone/element uuid.
   *
   * Blockbench stores animation rotation keyframes as *offsets* from the rest
   * rotation, exactly like position keyframes are offsets from the rest position.
   * A bone whose rest rotation is `[0, 0, -20]` with a keyframe of `[0, 0, 0]`
   * keeps that -20 tilt. Treating the keyframe as absolute discards the rest
   * rotation — which is what makes a head look up when the animation wants down.
   */
  const restRotations: Record<string, [number, number, number]> = {};

  // Faces with nothing to sample still need a map: a material that combines
  // alphaTest with no texture discards every fragment, and hiding the material
  // would drop the element entirely. A 1x1 white texture keeps the cube visible
  // and lets it light like an untextured Blockbench cube.
  const blankTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  blankTexture.needsUpdate = true;
  blankTexture.colorSpace = THREE.SRGBColorSpace;

  for (const element of elements) {
    const { from, to, faces = {}, origin, rotation, uuid, visibility } = element;

    // Mesh elements (type: "mesh") are free-form and carry `vertices` instead of
    // from/to, and malformed exports can hold nulls. Skipping one bad element is
    // much better than failing the whole model.
    if (!isFiniteVec3(from) || !isFiniteVec3(to)) {
      skipped += 1;
      continue;
    }

    const w = to[0] - from[0];
    const h = to[1] - from[1];
    const d = to[2] - from[2];

    const geometry = new THREE.BoxGeometry(w, h, d);
    const materials: THREE.Material[] = [];

    // Some exports (untextured box_uv models especially) omit `faces` rather
    // than listing the enabled ones. No face data means "draw the whole cube" —
    // only a face missing from a populated `faces` is deliberately disabled.
    const hasFaceData = Object.keys(faces).length > 0;

    FACE_ORDER.forEach((faceName, faceIndex) => {
      const face = hasFaceData ? faces[faceName] : undefined;

      if (hasFaceData && !face) {
        materials.push(new THREE.MeshBasicMaterial({ visible: false }));
        return;
      }

      const textureIndex = typeof face?.texture === "number" ? face.texture : 0;
      const texture = textures[textureIndex] ?? textures[0] ?? blankTexture;

      if (texture === blankTexture) {
        materials.push(new THREE.MeshLambertMaterial({ map: blankTexture, color: 0xb0b0b0 }));
      } else {
        materials.push(
          new THREE.MeshLambertMaterial({ map: texture, transparent: true, alphaTest: 0.5 }),
        );
      }

      const uvs = face?.uv;
      if (!uvs) return;

      // Placeholder faces keep BoxGeometry's default 0..1 UVs.
      const info = infoOf(texture);
      // Face UVs are in *image pixel* coordinates. Measured on three models whose
      // uv_width/uv_height differ from the image: crystal_golem (UVs 0..60 over a
      // 128x128 image whose painted content ends at 59), house and gloomper — the
      // UVs always track the image, never the uv space. So both axes divide by the
      // image size.
      //
      // The exception is a flipbook, where the UVs live inside a single frame, so
      // V runs over the frame height and repeat/offset select the frame band.
      if (!info.width || !info.height) return;
      const vScale = info.isAnimated ? info.uvHeight : info.height;

      const u0 = uvs[0] / info.width;
      const v0 = 1 - uvs[1] / vScale;
      const u1 = uvs[2] / info.width;
      const v1 = 1 - uvs[3] / vScale;

      let corners = [
        new THREE.Vector2(u0, v0), // TL
        new THREE.Vector2(u1, v0), // TR
        new THREE.Vector2(u0, v1), // BL
        new THREE.Vector2(u1, v1), // BR
      ];

      if (face.rotation) {
        const steps = face.rotation / 90;
        for (let i = 0; i < steps; i += 1) {
          const [c0, c1, c2, c3] = corners;
          corners = [c2, c0, c3, c1];
        }
      }

      // BoxGeometry lays faces out as 4 vertices each, in FACE_ORDER.
      const offset = faceIndex * 4;
      geometry.attributes.uv.setXY(offset + 0, corners[0].x, corners[0].y);
      geometry.attributes.uv.setXY(offset + 1, corners[1].x, corners[1].y);
      geometry.attributes.uv.setXY(offset + 2, corners[2].x, corners[2].y);
      geometry.attributes.uv.setXY(offset + 3, corners[3].x, corners[3].y);
    });

    const mesh = new THREE.Mesh(geometry, materials);
    if (visibility === false) mesh.visible = false;

    const center = new THREE.Vector3(from[0] + w / 2, from[1] + h / 2, from[2] + d / 2);

    let object: THREE.Object3D;
    if (rotation) {
      // Rotate around the element's origin, not its centre.
      const pivot = new THREE.Group();
      const pivotOrigin = new THREE.Vector3(origin?.[0] ?? 0, origin?.[1] ?? 0, origin?.[2] ?? 0);
      pivot.userData.globalPosition = pivotOrigin.clone();

      mesh.position.copy(center).sub(pivotOrigin);
      pivot.rotation.copy(toRadians(rotation));
      pivot.add(mesh);
      object = pivot;
    } else {
      mesh.userData.globalPosition = center.clone();
      object = mesh;
    }

    if (uuid) {
      object.uuid = uuid;
      elementObjects[uuid] = object;
      restRotations[uuid] = rotation
        ? [toNumber(rotation[0]), toNumber(rotation[1]), toNumber(rotation[2])]
        : [0, 0, 0];
    }
  }

  /* 3. Hierarchy — outliner nodes become bones, string nodes become elements. */
  const root = new THREE.Group();
  const bones: Record<string, THREE.Group> = {};
  const boneRestPositions: Record<string, THREE.Vector3> = {};

  const groupMap: Record<string, BBGroup> = {};
  for (const group of bbmodel.groups ?? []) groupMap[group.uuid] = group;

  const processNode = (
    node: Exclude<BBOutlinerNode, string>,
    parentOrigin: THREE.Vector3,
    parent: THREE.Object3D,
  ): void => {
    // Two layouts exist in the wild. Newer files keep group metadata in the
    // top-level `groups` array and use bare { uuid, children } outliner nodes;
    // older ones (and several modded/animated exports) inline `name`, `origin`
    // and `rotation` directly on the outliner node and ship no `groups` at all.
    const group = groupMap[node.uuid] ?? node;

    const bone = new THREE.Group();
    bone.name = group.name ?? "";
    // three.js resolves animation tracks by name *or* uuid, so keeping the
    // bbmodel uuid here is what makes the clips below bind.
    bone.uuid = group.uuid;
    bones[group.uuid] = bone;

    // A missing origin must not drop the subtree. Origins only affect rotation
    // pivots: an element's final position works out to its absolute bbmodel
    // coordinates whichever origin the enclosing bones use.
    const origin = isFiniteVec3(group.origin)
      ? new THREE.Vector3(group.origin[0], group.origin[1], group.origin[2])
      : new THREE.Vector3(0, 0, 0);

    const localPosition = origin.clone().sub(parentOrigin);
    bone.position.copy(localPosition);
    boneRestPositions[group.uuid] = localPosition.clone();

    if (group.rotation) {
      bone.rotation.copy(toRadians(group.rotation));
    }
    restRotations[group.uuid] = [
      toNumber(group.rotation?.[0]),
      toNumber(group.rotation?.[1]),
      toNumber(group.rotation?.[2]),
    ];

    parent.add(bone);

    for (const child of node.children ?? []) {
      if (typeof child === "string") {
        const element = elementObjects[child];
        if (!element) continue;
        element.position.copy(
          (element.userData.globalPosition as THREE.Vector3).clone().sub(origin),
        );
        bone.add(element);
      } else {
        processNode(child, origin, bone);
      }
    }
  };

  const worldOrigin = new THREE.Vector3(0, 0, 0);

  if (bbmodel.outliner) {
    for (const node of bbmodel.outliner) {
      if (typeof node === "string") {
        const element = elementObjects[node];
        if (!element) continue;
        element.position.copy(
          (element.userData.globalPosition as THREE.Vector3).clone().sub(worldOrigin),
        );
        root.add(element);
      } else {
        processNode(node, worldOrigin, root);
      }
    }
  } else {
    for (const element of Object.values(elementObjects)) {
      element.position.copy(
        (element.userData.globalPosition as THREE.Vector3).clone().sub(worldOrigin),
      );
      root.add(element);
    }
  }

  /* 4. Animations */
  const clips: THREE.AnimationClip[] = [];

  for (const animation of bbmodel.animations ?? []) {
    const tracks: THREE.KeyframeTrack[] = [];

    for (const [targetUuid, animator] of Object.entries(animation.animators ?? {})) {
      const bone = bones[targetUuid] ?? elementObjects[targetUuid];
      if (!bone || !animator.keyframes) continue;

      const keyframes = [...animator.keyframes].sort((a, b) => a.time - b.time);

      const rotationFrames: RotationFrame[] = [];
      const positionTimes: number[] = [];
      const positionValues: number[] = [];

      for (const keyframe of keyframes) {
        const point = keyframe.data_points[0];
        if (!point) continue;

        if (keyframe.channel === "rotation") {
          const rest = restRotations[targetUuid] ?? [0, 0, 0];
          rotationFrames.push({
            time: keyframe.time,
            degrees: [
              rest[0] + toNumber(point.x),
              rest[1] + toNumber(point.y),
              rest[2] + toNumber(point.z),
            ],
          });
        } else if (keyframe.channel === "position") {
          positionTimes.push(keyframe.time);
          const rest = boneRestPositions[targetUuid] ?? new THREE.Vector3();
          positionValues.push(
            rest.x + toNumber(point.x),
            rest.y + toNumber(point.y),
            rest.z + toNumber(point.z),
          );
        }
      }

      const rotationTrack = buildRotationTrack(`${bone.uuid}.quaternion`, rotationFrames);
      if (rotationTrack) tracks.push(rotationTrack);
      if (positionTimes.length > 0) {
        tracks.push(
          new THREE.VectorKeyframeTrack(`${bone.uuid}.position`, positionTimes, positionValues),
        );
      }
    }

    if (tracks.length > 0) {
      clips.push(new THREE.AnimationClip(animation.name, animation.length ?? -1, tracks));
    }
  }

  return {
    root,
    clips,
    animatedTextures,
    elements: elements.length,
    textures: textures.length,
    skipped,
  };
}

/* ── Cleanup ────────────────────────────────────────────────────────── */

/**
 * Bounding box of only the *drawn* geometry.
 *
 * `Box3.setFromObject` includes elements the model marked `visibility: false`.
 * Hidden helper elements (commonly named "dontTouch") are routine in Blockbench
 * files, and letting them inflate the box makes the camera zoom out until the
 * real model is a speck — or invisible. `traverseVisible` skips hidden subtrees.
 */
function visibleBounds(root: THREE.Object3D): THREE.Box3 {
  const bounds = new THREE.Box3();
  const scratch = new THREE.Box3();

  root.updateWorldMatrix(true, true);
  root.traverseVisible((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const geometryBox = mesh.geometry.boundingBox;
    if (!geometryBox) return;
    scratch.copy(geometryBox).applyMatrix4(mesh.matrixWorld);
    bounds.union(scratch);
  });

  return bounds;
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      const map = (material as THREE.MeshLambertMaterial).map;
      if (map) map.dispose();
      material.dispose();
    }
  });
}

/* ── Viewer ─────────────────────────────────────────────────────────── */

export function createViewer(
  container: HTMLElement,
  options: ViewerOptions = {},
): ModelViewer {
  const resolveTexture = options.resolveTexture ?? ((source: string) => source);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1117);

  const camera = new THREE.PerspectiveCamera(
    55,
    Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1),
    0.1,
    5000,
  );
  camera.position.set(0, 20, 40);

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    options.onError?.(failure);
    throw failure;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.update();

  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2);
  keyLight.position.set(50, 50, 50);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.8);
  fillLight.position.set(-50, 20, -50);
  scene.add(fillLight);

  const clock = new THREE.Clock();

  let model: THREE.Group | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  let clips: THREE.AnimationClip[] = [];
  let animatedTextures: THREE.Texture[] = [];
  let grid: THREE.GridHelper | null = null;

  function clearModel(): void {
    mixer?.stopAllAction();
    mixer = null;
    clips = [];
    animatedTextures = [];

    if (model) {
      scene.remove(model);
      disposeObject(model);
      model = null;
    }
    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      grid = null;
    }
  }

  function resize(): void {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }

  function frameModel(): void {
    if (!model) return;

    // Frame what is actually drawn; fall back to everything if it is all hidden
    // so the grid at least lands somewhere sensible.
    let box = visibleBounds(model);
    if (box.isEmpty()) box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);

    const distance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.25;
    // Minecraft/Blockbench models are authored facing -Z — every model checked
    // puts the head at negative Z (spider -3, mog -6, golem -10). A camera on +Z
    // therefore looks at the model's back, so the default view sits on -Z.
    const direction = new THREE.Vector3(1, 0.55, -1).normalize();

    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max(distance / 100, 0.01);
    camera.far = distance * 20;
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.minDistance = radius * 0.2;
    controls.maxDistance = distance * 6;
    controls.update();

    // Ground grid, sized to the model and sat at its base.
    const extent = Math.max(16, Math.ceil(Math.max(size.x, size.z) / 16) * 16);
    grid = new THREE.GridHelper(extent, extent / 16, 0x3a4a5e, 0x222c38);
    grid.position.set(center.x, box.min.y, center.z);
    scene.add(grid);
  }

  function animate(): void {
    const delta = clock.getDelta();

    mixer?.update(delta);

    if (animatedTextures.length > 0) {
      const deltaMs = delta * 1000;
      for (const texture of animatedTextures) {
        const info = infoOf(texture);
        if (!info.frameTime || !info.frameCount || !info.tileHeight) continue;

        info.timeAccumulator = (info.timeAccumulator ?? 0) + deltaMs;
        if (info.timeAccumulator >= info.frameTime) {
          const advance = Math.floor(info.timeAccumulator / info.frameTime);
          info.timeAccumulator -= advance * info.frameTime;
          info.currentFrame = ((info.currentFrame ?? 0) + advance) % info.frameCount;
          texture.offset.y =
            (info.frameCount - 1 - (info.currentFrame ?? 0)) * info.tileHeight;
        }
      }
    }

    controls.update();
    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(animate);

  async function load(jsonText: string): Promise<LoadResult> {
    const parsed = JSON.parse(jsonText) as BBModel;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("That does not look like a bbmodel file.");
    }
    if (!Array.isArray(parsed.elements)) {
      throw new Error("No \"elements\" array — this is not a Blockbench model.");
    }

    clearModel();

    const built = buildModel(parsed, resolveTexture);
    model = built.root;
    clips = built.clips;
    animatedTextures = built.animatedTextures;
    scene.add(model);

    // Centre on X/Z so the model sits over the grid regardless of where the
    // author placed it; keep Y so it still stands on its own base.
    const rawBox = new THREE.Box3().setFromObject(model);
    const rawCenter = rawBox.getCenter(new THREE.Vector3());
    model.position.set(-rawCenter.x, 0, -rawCenter.z);

    frameModel();

    mixer = new THREE.AnimationMixer(model);
    if (clips.length > 0) playAnimation(clips[0].name);

    return {
      animations: clips.map((clip) => clip.name),
      elements: built.elements,
      textures: built.textures,
      skipped: built.skipped,
    };
  }

  function playAnimation(name: string): void {
    if (!mixer || !model) return;
    mixer.stopAllAction();
    if (!name) return;

    const clip = clips.find((candidate) => candidate.name === name);
    if (!clip) return;

    mixer.clipAction(clip).play();
  }

  function dispose(): void {
    renderer.setAnimationLoop(null);
    clearModel();
    controls.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return { load, playAnimation, clear: clearModel, resize, dispose };
}
