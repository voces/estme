import {
  Box3,
  BufferGeometry,
  Color,
  DataTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Intersection,
  Material,
  Matrix4,
  MeshBasicMaterial,
  Mesh,
  Object3D,
  Ray,
  Raycaster,
  Sphere,
} from "three";
import { BVH } from "./BVH.ts";
import { getShaderRef } from "./AnimatedMeshMaterial.ts";

const dummy = new Object3D();
const dummyColor = new Color();

const _tempBox = new Box3();
const _instanceLocalMatrix = new Matrix4();
const _box3 = new Box3();
const _sphere = new Sphere();

/** Normalizes an angle to the range (-π, π]. */
const normalizeAngle = (angle: number): number => {
  angle = angle % (2 * Math.PI);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  if (angle <= -Math.PI) angle += 2 * Math.PI;
  return angle;
};

/**
 * Animation data for a model.
 * Transform and opacity are stored in textures for GPU-side animation.
 */
export interface AnimationData {
  /** Number of parts in the model */
  partCount: number;
  /** Number of samples per animation clip */
  sampleCount: number;
  /** Animation clips: name -> clip index */
  clips: Map<string, number>;
  /**
   * Transform texture (RGBA32F):
   * - R = tx, G = ty, B = rot (radians), A = scale
   * - Width = sampleCount
   * - Height = partCount * clipCount
   * - Row = clipIndex * partCount + partIndex
   */
  transformTexture: DataTexture;
  /**
   * Opacity texture (R32F or R16F):
   * - R = opacity
   * - Same layout as transform texture
   */
  opacityTexture: DataTexture;
}

/**
 * AnimatedInstancedMesh - Instanced mesh with GPU-driven part-based animation.
 *
 * Animation is entirely GPU-side:
 * - Each vertex has a partID attribute
 * - Per-instance: animClip, animPhase, animSpeed
 * - Shader samples transform/opacity textures based on uTime
 *
 * Also supports (from InstancedSvg):
 * - Per-instance: alpha, player color, tint, minimap mask
 * - Per-vertex: color, playerMask
 */
export class AnimatedInstancedMesh extends InstancedMesh {
  private map: Record<string, number> = {};
  private reverseMap: string[] = [];
  private innerCount: number;
  private bvh: BVH;
  private skipBoundsRecalc: boolean;
  private mapUtilizationThreshold: number;

  /** Animation data (textures, clip info) */
  readonly animationData: AnimationData | null;

  constructor(
    geometry: BufferGeometry,
    material: Material,
    count: number = 1,
    readonly modelName?: string,
    animationData?: AnimationData,
    options?: {
      skipBoundsRecalc?: boolean;
      mapUtilizationThreshold?: number;
    },
  ) {
    super(geometry, material, count);

    this.animationData = animationData ?? null;
    this.bvh = new BVH(modelName);
    this.bvh.setGetBoundingBox((index) => {
      this.getMatrixAt(index, _instanceLocalMatrix);
      if (!this.isFiniteMatrix(_instanceLocalMatrix)) return null;
      return this.computeInstanceBoundingBox(index);
    });
    this.innerCount = count;
    this.skipBoundsRecalc = options?.skipBoundsRecalc ?? false;
    this.mapUtilizationThreshold = options?.mapUtilizationThreshold ?? 0.5;

    // Add instance attributes
    this.initializeInstanceAttributes(count);

    // Patch bounding box/sphere computation
    this.patchBounds();

    // Set up onBeforeRender to update animation uniforms per-mesh
    this.onBeforeRender = (_renderer, _scene, _camera, _geometry, _material) => {
      if (!(material instanceof MeshBasicMaterial)) return;
      const shaderRef = getShaderRef(material);
      if (!shaderRef) return;

      // Update uniforms with this mesh's animation data
      if (this.animationData) {
        shaderRef.uniforms.uTransformTex.value = this.animationData.transformTexture;
        shaderRef.uniforms.uOpacityTex.value = this.animationData.opacityTexture;
        shaderRef.uniforms.uSampleCount.value = this.animationData.sampleCount;
        shaderRef.uniforms.uPartCount.value = this.animationData.partCount;
      } else {
        // No animation
        shaderRef.uniforms.uTransformTex.value = null;
        shaderRef.uniforms.uOpacityTex.value = null;
        shaderRef.uniforms.uSampleCount.value = 1;
        shaderRef.uniforms.uPartCount.value = 0;
      }
      // uTime is updated globally once per frame via updateAnimationTime()
    };

    // Initialize all instances at infinity
    for (let i = 0; i < count; i++) {
      this.setPositionAt(i, Infinity, Infinity, undefined, Infinity);
    }
  }

  private initializeInstanceAttributes(count: number) {
    const geo = this.geometry;

    // Instance alpha (float)
    const instanceAlphaAttr = new InstancedBufferAttribute(
      new Float32Array(count),
      1,
    );
    instanceAlphaAttr.array.fill(1);
    instanceAlphaAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute("instanceAlpha", instanceAlphaAttr);

    // Minimap mask (float)
    const instanceMinimapMaskAttr = new InstancedBufferAttribute(
      new Float32Array(count),
      1,
    );
    instanceMinimapMaskAttr.array.fill(0);
    instanceMinimapMaskAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute("instanceMinimapMask", instanceMinimapMaskAttr);

    // Player color (vec3) - accent color for player-masked vertices
    const instancePlayerColorAttr = new InstancedBufferAttribute(
      new Float32Array(count * 3),
      3,
    );
    for (let i = 0; i < count * 3; i++) {
      instancePlayerColorAttr.array[i] = 1;
    }
    instancePlayerColorAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute("instancePlayerColor", instancePlayerColorAttr);

    // Tint color (vec4) - overall tint applied to non-player vertices
    // RGB = tint color, A = tint strength (0 = no tint, 1 = full tint)
    const instanceTintAttr = new InstancedBufferAttribute(
      new Float32Array(count * 4),
      4,
    );
    // Default: white with 0 strength (no tint)
    for (let i = 0; i < count; i++) {
      instanceTintAttr.array[i * 4] = 1;     // R
      instanceTintAttr.array[i * 4 + 1] = 1; // G
      instanceTintAttr.array[i * 4 + 2] = 1; // B
      instanceTintAttr.array[i * 4 + 3] = 0; // strength
    }
    instanceTintAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute("instanceTint", instanceTintAttr);

    // Animation state (vec3): animClip, animPhase, animSpeed
    // animClip: which clip (index into clips)
    // animPhase: phase offset (0-1, added to time)
    // animSpeed: playback speed multiplier
    const instanceAnimAttr = new InstancedBufferAttribute(
      new Float32Array(count * 3),
      3,
    );
    // Default: clip 0, phase 0, speed 1
    for (let i = 0; i < count; i++) {
      instanceAnimAttr.array[i * 3] = 0;     // clip
      instanceAnimAttr.array[i * 3 + 1] = 0; // phase
      instanceAnimAttr.array[i * 3 + 2] = 1; // speed
    }
    instanceAnimAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute("instanceAnim", instanceAnimAttr);
  }

  resize(value: number) {
    const geo = this.geometry;

    // Resize instance matrix
    const oldMatrixArray = this.instanceMatrix.array;
    const newMatrixArray = new Float32Array(value * 16);
    newMatrixArray.set(
      oldMatrixArray.slice(0, Math.min(value, this.innerCount) * 16),
    );
    // Initialize new instances at infinity
    dummy.matrix.setPosition(Infinity, Infinity, Infinity);
    for (let n = this.innerCount; n < value; n++) {
      dummy.matrix.toArray(newMatrixArray, n * 16);
    }
    this.instanceMatrix = new InstancedBufferAttribute(newMatrixArray, 16);
    this.instanceMatrix.setUsage(DynamicDrawUsage);

    // Resize instance color if it exists
    if (this.instanceColor) {
      const oldColorArray = this.instanceColor.array;
      const newColorArray = new Float32Array(value * 3);
      newColorArray.set(
        oldColorArray.slice(0, Math.min(value, this.innerCount) * 3),
      );
      for (let i = this.innerCount * 3; i < value * 3; i += 3) {
        newColorArray[i] = 1;
        newColorArray[i + 1] = 1;
        newColorArray[i + 2] = 1;
      }
      this.instanceColor = new InstancedBufferAttribute(newColorArray, 3);
      this.instanceColor.setUsage(DynamicDrawUsage);
    }

    // Helper to resize a float attribute with a single default value
    const resizeFloatAttr = (name: string, components: number, defaultValue: number) => {
      const oldAttr = geo.getAttribute(name);
      const newAttr = new InstancedBufferAttribute(
        new Float32Array(value * components),
        components,
      );
      newAttr.array.fill(defaultValue);
      if (oldAttr) {
        (newAttr.array as Float32Array).set(
          (oldAttr.array as Float32Array).slice(
            0,
            Math.min(value, this.innerCount) * components,
          ),
        );
      }
      newAttr.setUsage(DynamicDrawUsage);
      geo.setAttribute(name, newAttr);
    };

    resizeFloatAttr("instanceAlpha", 1, 1);
    resizeFloatAttr("instanceMinimapMask", 1, 0);

    // Resize instancePlayerColor (default to white)
    const oldPlayerColorAttr = geo.getAttribute("instancePlayerColor");
    const newPlayerColorAttr = new InstancedBufferAttribute(
      new Float32Array(value * 3),
      3,
    );
    for (let i = 0; i < value * 3; i++) {
      newPlayerColorAttr.array[i] = 1;
    }
    if (oldPlayerColorAttr) {
      (newPlayerColorAttr.array as Float32Array).set(
        (oldPlayerColorAttr.array as Float32Array).slice(
          0,
          Math.min(value, this.innerCount) * 3,
        ),
      );
    }
    newPlayerColorAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute("instancePlayerColor", newPlayerColorAttr);

    // Resize instanceTint (default to white with 0 strength)
    const oldTintAttr = geo.getAttribute("instanceTint");
    const newTintAttr = new InstancedBufferAttribute(
      new Float32Array(value * 4),
      4,
    );
    for (let i = 0; i < value; i++) {
      newTintAttr.array[i * 4] = 1;
      newTintAttr.array[i * 4 + 1] = 1;
      newTintAttr.array[i * 4 + 2] = 1;
      newTintAttr.array[i * 4 + 3] = 0;
    }
    if (oldTintAttr) {
      (newTintAttr.array as Float32Array).set(
        (oldTintAttr.array as Float32Array).slice(
          0,
          Math.min(value, this.innerCount) * 4,
        ),
      );
    }
    newTintAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute("instanceTint", newTintAttr);

    // Resize instanceAnim (default: clip 0, phase 0, speed 1)
    const oldAnimAttr = geo.getAttribute("instanceAnim");
    const newAnimAttr = new InstancedBufferAttribute(
      new Float32Array(value * 3),
      3,
    );
    for (let i = 0; i < value; i++) {
      newAnimAttr.array[i * 3] = 0;
      newAnimAttr.array[i * 3 + 1] = 0;
      newAnimAttr.array[i * 3 + 2] = 1;
    }
    if (oldAnimAttr) {
      (newAnimAttr.array as Float32Array).set(
        (oldAnimAttr.array as Float32Array).slice(
          0,
          Math.min(value, this.innerCount) * 3,
        ),
      );
    }
    newAnimAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute("instanceAnim", newAnimAttr);

    // Update map for removed instances
    for (let i = this.innerCount; i > value; i--) {
      const id = this.reverseMap[i];
      delete this.map[id];
    }
    if (this.innerCount > value) this.reverseMap.splice(value);

    this.innerCount = value;
    // deno-lint-ignore no-explicit-any
    (this as any).count = value;
  }

  getCount() {
    return this.innerCount;
  }

  delete(id: string) {
    if (!(id in this.map)) return;
    const index = this.map[id];
    const swapIndex = this.reverseMap.length - 1;

    if (swapIndex !== index) {
      const swapId = this.reverseMap[swapIndex];

      this.getMatrixAt(swapIndex, dummy.matrix);
      this.setMatrixAtIndex(index, dummy.matrix);

      this.setPositionAt(swapId, Infinity, Infinity, undefined, Infinity);

      if (this.instanceColor?.array) {
        this.getColorAt(swapIndex, dummyColor);
        this.setColorAt(index, dummyColor);
        this.instanceColor.needsUpdate = true;
      }

      // Copy all instance attributes from swapIndex to index
      const copyAttr = (name: string, components: number) => {
        const attr = this.geometry.getAttribute(name);
        if (!attr) return;
        for (let c = 0; c < components; c++) {
          const value = (attr.array as Float32Array)[swapIndex * components + c];
          (attr.array as Float32Array)[index * components + c] = value;
        }
        attr.needsUpdate = true;
      };

      copyAttr("instanceAlpha", 1);
      copyAttr("instanceMinimapMask", 1);
      copyAttr("instancePlayerColor", 3);
      copyAttr("instanceTint", 4);
      copyAttr("instanceAnim", 3);

      this.map[swapId] = index;
      this.reverseMap[index] = swapId;
    } else {
      dummy.matrix.setPosition(Infinity, Infinity, Infinity);
      this.setMatrixAtIndex(index, dummy.matrix);
    }

    delete this.map[id];
    this.reverseMap.pop();
  }

  private getIndex(id: string) {
    if (id in this.map) return this.map[id];
    const index = this.reverseMap.push(id) - 1;
    this.map[id] = index;
    if (index + 1 > this.getCount()) this.resize((index + 1) * 2);

    // Initialize new instance with default values
    dummy.matrix.identity();
    this.setMatrixAtIndex(index, dummy.matrix);

    if (this.instanceColor) {
      this.setColorAt(index, new Color(1, 1, 1));
      this.instanceColor.needsUpdate = true;
    }

    const setAttrDefault = (name: string, values: number[]) => {
      const attr = this.geometry.getAttribute(name);
      if (!attr) return;
      for (let c = 0; c < values.length; c++) {
        (attr.array as Float32Array)[index * values.length + c] = values[c];
      }
      attr.needsUpdate = true;
    };

    setAttrDefault("instanceAlpha", [1]);
    setAttrDefault("instanceMinimapMask", [0]);
    setAttrDefault("instancePlayerColor", [1, 1, 1]);
    setAttrDefault("instanceTint", [1, 1, 1, 0]);
    setAttrDefault("instanceAnim", [0, 0, 1]); // clip 0, phase 0, speed 1

    return index;
  }

  getId(index: number): string | undefined {
    return this.reverseMap[index];
  }

  private setMatrixAtIndex(index: number, matrix: Matrix4) {
    this.setMatrixAt(index, matrix);
    this.instanceMatrix.needsUpdate = true;
    this.updateBvhInstance(index, matrix);
  }

  private updateBvhInstance(index: number, matrix: Matrix4) {
    if (!this.isFiniteMatrix(matrix)) {
      this.bvh.queueUpdate(index, null);
    } else {
      const bbox = this.computeInstanceBoundingBox(index);
      this.bvh.queueUpdate(index, bbox);
    }
  }

  private patchBounds() {
    // deno-lint-ignore no-this-alias
    const self = this;

    this.computeBoundingBox = function () {
      const geometry = this.geometry;

      if (this.boundingBox === null) {
        this.boundingBox = new Box3();
      }

      if (geometry.boundingBox === null) {
        geometry.computeBoundingBox();
      }

      this.boundingBox.makeEmpty();

      for (let i = 0; i < self.innerCount; i++) {
        this.getMatrixAt(i, _instanceLocalMatrix);
        if (self.isFiniteMatrix(_instanceLocalMatrix)) {
          _box3.copy(geometry.boundingBox!).applyMatrix4(_instanceLocalMatrix);
          this.boundingBox.union(_box3);
        }
      }
    };

    this.computeBoundingSphere = function () {
      const geometry = this.geometry;

      if (this.boundingSphere === null) this.boundingSphere = new Sphere();

      if (geometry.boundingSphere === null) geometry.computeBoundingSphere();

      this.boundingSphere.makeEmpty();

      for (let i = 0; i < self.innerCount; i++) {
        this.getMatrixAt(i, _instanceLocalMatrix);
        if (self.isFiniteMatrix(_instanceLocalMatrix)) {
          _sphere.copy(geometry.boundingSphere!).applyMatrix4(
            _instanceLocalMatrix,
          );
          this.boundingSphere.union(_sphere);
        }
      }
    };
  }

  private debouncingBoundingBox = false;
  private debouncedComputeBoundingBox() {
    if (this.skipBoundsRecalc) return;
    if (this.debouncingBoundingBox) return;
    this.debouncingBoundingBox = true;
    queueMicrotask(() => {
      this.debouncingBoundingBox = false;
      this.computeBoundingBox();
    });
  }

  private debouncingBoundingSphere = false;
  private debouncedComputeBoundingSphere() {
    if (this.skipBoundsRecalc) return;
    if (this.debouncingBoundingSphere) return;
    this.debouncingBoundingSphere = true;
    queueMicrotask(() => {
      this.debouncingBoundingSphere = false;
      this.computeBoundingSphere();
    });
  }

  setPositionAt(
    index: number | string,
    x: number,
    y: number,
    angle?: number | null,
    z?: number,
  ) {
    if (typeof index === "string") index = this.getIndex(index);

    this.getMatrixAt(index, dummy.matrix);
    dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);

    if (typeof angle === "number") {
      const norm = normalizeAngle(angle);
      const flip = norm < (Math.PI / 2) && norm > (Math.PI / -2);
      dummy.rotation.z = flip ? Math.PI - norm : norm + Math.PI;
      dummy.rotation.x = flip ? Math.PI : 0;
    } else {
      dummy.rotation.z = 0;
      dummy.rotation.x = 0;
    }
    dummy.position.set(
      x,
      y,
      z ?? (Number.isFinite(dummy.position.z) ? dummy.position.z : 0),
    );
    dummy.updateMatrix();

    this.setMatrixAt(index, dummy.matrix);
    this.instanceMatrix.needsUpdate = true;
    this.debouncedComputeBoundingBox();
    this.debouncedComputeBoundingSphere();
    this.updateBvhInstance(index, dummy.matrix);
  }

  getPositionAt(index: number | string) {
    if (typeof index === "string") index = this.getIndex(index);
    this.getMatrixAt(index, dummy.matrix);
    dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
    return dummy.position.clone();
  }

  private initializeInstanceColorWithWhite() {
    if (!this.instanceColor) {
      const white = new Color(1, 1, 1);
      for (let i = 0; i < this.getCount(); i++) {
        this.setColorAt(i, white);
      }
    }
  }

  setPlayerColorAt(index: number | string, color: Color) {
    if (typeof index === "string") index = this.getIndex(index);
    const playerColorAttr = this.geometry.getAttribute("instancePlayerColor");
    playerColorAttr.setXYZ(index, color.r, color.g, color.b);
    playerColorAttr.needsUpdate = true;
  }

  setVertexColorAt(index: number | string, color: Color) {
    if (typeof index === "string") index = this.getIndex(index);
    this.initializeInstanceColorWithWhite();
    this.setColorAt(index, color);
    if (this.instanceColor) this.instanceColor.needsUpdate = true;
  }

  setAlphaAt(index: number | string, alpha: number) {
    if (typeof index === "string") index = this.getIndex(index);
    const instanceAlphaAttr = this.geometry.getAttribute("instanceAlpha");
    instanceAlphaAttr.setX(index, alpha);
    instanceAlphaAttr.needsUpdate = true;
  }

  setMinimapMaskAt(index: number | string, maskValue: number) {
    if (typeof index === "string") index = this.getIndex(index);
    const instanceMinimapMaskAttr = this.geometry.getAttribute(
      "instanceMinimapMask",
    );
    instanceMinimapMaskAttr.setX(index, maskValue);
    instanceMinimapMaskAttr.needsUpdate = true;
  }

  /**
   * Set tint color for an instance.
   * Tint is blended with the base vertex color for non-player vertices.
   * Player-masked vertices are NOT affected by tint.
   */
  setTintAt(index: number | string, color: Color, strength: number = 1) {
    if (typeof index === "string") index = this.getIndex(index);
    const tintAttr = this.geometry.getAttribute("instanceTint");
    tintAttr.setXYZW(index, color.r, color.g, color.b, strength);
    tintAttr.needsUpdate = true;
  }

  /** Clear tint for an instance (reset to no tint). */
  clearTintAt(index: number | string) {
    if (typeof index === "string") index = this.getIndex(index);
    const tintAttr = this.geometry.getAttribute("instanceTint");
    tintAttr.setXYZW(index, 1, 1, 1, 0);
    tintAttr.needsUpdate = true;
  }

  /**
   * Set animation state for an instance.
   * @param index Instance index or ID
   * @param clip Animation clip index (or name if animationData exists)
   * @param phase Phase offset (0-1, added to time for desync)
   * @param speed Playback speed multiplier (1 = normal, 2 = double speed)
   */
  setAnimationAt(
    index: number | string,
    clip: number | string,
    phase: number = 0,
    speed: number = 1,
  ) {
    if (typeof index === "string") index = this.getIndex(index);

    let clipIndex: number;
    if (typeof clip === "string") {
      clipIndex = this.animationData?.clips.get(clip) ?? 0;
    } else {
      clipIndex = clip;
    }

    const animAttr = this.geometry.getAttribute("instanceAnim");
    animAttr.setXYZ(index, clipIndex, phase, speed);
    animAttr.needsUpdate = true;
  }

  /** Get clip index by name. */
  getClipIndex(name: string): number | undefined {
    return this.animationData?.clips.get(name);
  }

  saveInstanceColors(index: number | string): Color | null {
    if (typeof index === "string") index = this.getIndex(index);
    if (this.instanceColor) {
      const savedColor = new Color();
      this.getColorAt(index, savedColor);
      return savedColor;
    }
    return null;
  }

  restoreInstanceColors(index: number | string, color: Color | null) {
    if (typeof index === "string") index = this.getIndex(index);
    if (color) {
      this.setColorAt(index, color);
      if (this.instanceColor) this.instanceColor.needsUpdate = true;
    }
  }

  setScaleAt(index: number | string, scale: number, aspectRatio?: number) {
    if (typeof index === "string") index = this.getIndex(index);

    this.getMatrixAt(index, dummy.matrix);
    dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
    dummy.scale.setScalar(scale);
    if (typeof aspectRatio === "number") {
      dummy.scale.setY(dummy.scale.y * aspectRatio);
    }
    dummy.updateMatrix();

    this.setMatrixAt(index, dummy.matrix);
    this.instanceMatrix.needsUpdate = true;
    this.debouncedComputeBoundingBox();
    this.debouncedComputeBoundingSphere();
    this.updateBvhInstance(index, dummy.matrix);
  }

  private computeInstanceBoundingBox(index: number): Box3 {
    _tempBox.makeEmpty();

    const geoBox = this.geometry.boundingBox;
    if (!geoBox) {
      this.geometry.computeBoundingBox();
    }

    const matrix = new Matrix4();
    this.getMatrixAt(index, matrix);

    _tempBox.copy(this.geometry.boundingBox!).applyMatrix4(matrix);
    return _tempBox.clone();
  }

  private isFiniteMatrix(m: Matrix4): boolean {
    const e = m.elements;
    return Number.isFinite(e[12]) && Number.isFinite(e[13]) &&
      Number.isFinite(e[14]);
  }

  override raycast(raycaster: Raycaster, intersects: Intersection[]) {
    const ray = new Ray().copy(raycaster.ray);
    const candidates = this.bvh.raycast(ray);

    for (const candidate of candidates) {
      const instanceMatrix = new Matrix4();
      this.getMatrixAt(candidate, instanceMatrix);

      const invMat = new Matrix4().copy(instanceMatrix).invert();
      const localRay = new Ray().copy(ray).applyMatrix4(invMat);

      const testMesh = new Mesh(this.geometry, this.material as Material);
      const localIntersects: Intersection[] = [];
      testMesh.raycast(
        { ...raycaster, ray: localRay } as Raycaster,
        localIntersects,
      );

      if (localIntersects.length > 0) {
        for (const hit of localIntersects) {
          hit.point.applyMatrix4(instanceMatrix);
          hit.object = this;
          hit.instanceId = candidate;
          intersects.push(hit);
        }
      }
    }

    return false;
  }
}
