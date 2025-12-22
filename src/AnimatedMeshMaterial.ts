import {
  DoubleSide,
  MeshBasicMaterial,
  WebGLProgramParametersWithUniforms,
} from "three";

/**
 * Shader customization for AnimatedInstancedMesh.
 *
 * Per-instance attributes:
 * - instanceAlpha (float): opacity
 * - instanceMinimapMask (float): if > 0.5, render as solid player color silhouette
 * - instancePlayerColor (vec3): accent color for player-masked vertices
 * - instanceTint (vec4): RGB tint color + A tint strength (0=none, 1=full)
 * - instanceAnim (vec3): animClip, animPhase, animSpeed
 *
 * Per-vertex attributes (in geometry):
 * - color (vec3): shape color
 * - playerMask (float): 1 if this vertex should use player coloring
 * - partID (float): which part this vertex belongs to (for animation)
 *
 * Uniforms (set per-mesh via onBeforeRender):
 * - uTransformTex (sampler2D): transform texture (RGBA32F: tx, ty, rot, scale)
 * - uOpacityTex (sampler2D): opacity texture (R32F: opacity)
 * - uSampleCount (float): number of samples per animation clip
 * - uPartCount (float): number of parts in the model
 * - uTime (float): global animation time (updated once per frame)
 */

// Store shader reference so we can update uniforms per-mesh
export interface AnimatedMeshShaderRef {
  uniforms: {
    uTransformTex: { value: unknown };
    uOpacityTex: { value: unknown };
    uSampleCount: { value: number };
    uPartCount: { value: number };
    uTime: { value: number };
  };
}

// WeakMap to store shader refs per material instance
const shaderRefs = new WeakMap<MeshBasicMaterial, AnimatedMeshShaderRef>();

export function getShaderRef(material: MeshBasicMaterial): AnimatedMeshShaderRef | undefined {
  return shaderRefs.get(material);
}

/**
 * Update the global animation time uniform.
 * Call this once per frame before rendering.
 * @param material The shared animated mesh material
 * @param timeSeconds Current time in seconds
 */
export function updateAnimationTime(material: MeshBasicMaterial, timeSeconds: number): void {
  const shaderRef = shaderRefs.get(material);
  if (shaderRef) {
    shaderRef.uniforms.uTime.value = timeSeconds;
  }
}

const addAnimatedInstanceShader = (
  shader: WebGLProgramParametersWithUniforms,
  material: MeshBasicMaterial,
) => {
  // Vertex shader declarations
  shader.vertexShader = `
    attribute float instanceAlpha;
    attribute float instanceMinimapMask;
    attribute vec3 instancePlayerColor;
    attribute vec4 instanceTint;
    attribute vec3 instanceAnim;
    attribute float playerMask;
    attribute float partID;
    attribute float alpha;

    uniform sampler2D uTransformTex;
    uniform sampler2D uOpacityTex;
    uniform float uSampleCount;
    uniform float uPartCount;
    uniform float uTime;

    varying float vInstanceAlpha;
    varying float vInstanceMinimapMask;
    varying float vPlayerMask;
    varying vec3 vPlayerColor;
    varying vec4 vInstanceTint;
    varying float vPartOpacity;
    varying float vVertexAlpha;
  ` + shader.vertexShader;

  // Replace main() to initialize varyings and apply part-based animation
  shader.vertexShader = shader.vertexShader.replace(
    "void main() {",
    `
    void main() {
      vInstanceAlpha = instanceAlpha;
      vInstanceMinimapMask = instanceMinimapMask;
      vPlayerMask = playerMask;
      vPlayerColor = instancePlayerColor;
      vInstanceTint = instanceTint;
      vPartOpacity = 1.0;
      vVertexAlpha = alpha;
    `,
  );

  // Add part-based animation before the standard position transform
  // Only apply if uPartCount > 0 (has animation)
  shader.vertexShader = shader.vertexShader.replace(
    "#include <begin_vertex>",
    `
    #include <begin_vertex>

    // Apply part-based animation if we have parts
    if (uPartCount > 0.0) {
      float animClip = instanceAnim.x;
      float animPhase = instanceAnim.y;
      float animSpeed = instanceAnim.z;

      // Compute normalized time (0-1) within the animation
      float t = fract(uTime * animSpeed + animPhase);

      // Compute texture coordinates
      // X = sample position within clip
      float sampleX = (t * (uSampleCount - 1.0) + 0.5) / uSampleCount;

      // Y = row for this clip + part
      // Row = clipIndex * partCount + partIndex
      float clipCount = 1.0; // Will be derived from texture height / partCount
      float textureHeight = uPartCount * clipCount;
      float row = animClip * uPartCount + partID;
      float sampleY = (row + 0.5) / textureHeight;

      // Sample transform texture: R=tx, G=ty, B=rot, A=scale
      vec4 tf = texture2D(uTransformTex, vec2(sampleX, sampleY));

      // Sample opacity texture
      vPartOpacity = texture2D(uOpacityTex, vec2(sampleX, sampleY)).r;

      // Apply transform to vertex position
      vec2 p = transformed.xy;

      // Scale (around origin, which is the part pivot)
      p *= tf.a;

      // Rotate
      float c = cos(tf.b);
      float s = sin(tf.b);
      p = mat2(c, -s, s, c) * p;

      // Translate
      p += tf.rg;

      transformed.xy = p;
    }
    `,
  );

  // Apply player color blending and tinting in vertex shader
  shader.vertexShader = shader.vertexShader.replace(
    /#include <color_vertex>/,
    `
    #if defined( USE_COLOR_ALPHA )
      vColor = vec4( 1.0 );
    #elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
      vColor = vec3( 1.0 );
    #endif

    #ifdef USE_COLOR
      vColor *= color;
    #endif

    // Player color: luminosity blend for player-masked vertices
    // Player vertices are NOT affected by tint
    // Midpoint at 0x80 (128/255): black->accent->white
    if (vPlayerMask > 0.5) {
      // Use simple average for brightness (works in linear space)
      float brightness = (vColor.r + vColor.g + vColor.b) / 3.0;
      // Midpoint at 128/255 ≈ 0.502
      float midpoint = 128.0 / 255.0;
      if (brightness < midpoint) {
        // Black to accent: scale accent color by brightness/midpoint
        vColor.xyz = instancePlayerColor * (brightness / midpoint);
      } else {
        // Accent to white: lerp from accent to white
        float t = (brightness - midpoint) / (1.0 - midpoint);
        vColor.xyz = mix(instancePlayerColor, vec3(1.0), t);
      }
    } else {
      // Non-player vertices: apply tint as a multiplier
      // instanceTint.rgb = tint color (multiplied with vertex color)
      vColor.xyz *= instanceTint.rgb;

      #ifdef USE_INSTANCING_COLOR
        vColor.xyz *= instanceColor.xyz;
      #endif
    }
    `,
  );

  // Fragment shader declarations
  shader.fragmentShader = `
    varying float vInstanceAlpha;
    varying float vInstanceMinimapMask;
    varying float vPlayerMask;
    varying vec3 vPlayerColor;
    varying vec4 vInstanceTint;
    varying float vPartOpacity;
    varying float vVertexAlpha;
  ` + shader.fragmentShader;

  // Apply instance alpha, part opacity, vertex alpha, and minimap mask in fragment shader
  shader.fragmentShader = shader.fragmentShader.replace(
    /vec4 diffuseColor = vec4\( diffuse, opacity \);/,
    `
    float finalOpacity = vInstanceAlpha * vPartOpacity * vVertexAlpha * opacity;
    vec4 diffuseColor = vec4( diffuse, finalOpacity );
    `,
  );

  // In minimap mode, use player color only (solid silhouette)
  shader.fragmentShader = shader.fragmentShader.replace(
    /#include <color_fragment>/,
    `
    #if defined( USE_COLOR_ALPHA )
      diffuseColor *= vInstanceMinimapMask > 0.5 ? vec4(vPlayerColor, 1.0) : vColor;
    #elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
      diffuseColor.rgb *= vInstanceMinimapMask > 0.5 ? vPlayerColor : vColor;
    #endif
    `,
  );

  // Add uniforms with default values (will be updated per-mesh)
  shader.uniforms.uTransformTex = { value: null };
  shader.uniforms.uOpacityTex = { value: null };
  shader.uniforms.uSampleCount = { value: 1 };
  shader.uniforms.uPartCount = { value: 0 };
  shader.uniforms.uTime = { value: 0 };

  // Store reference so we can update uniforms per-mesh
  shaderRefs.set(material, {
    uniforms: shader.uniforms as AnimatedMeshShaderRef["uniforms"],
  });
};

/**
 * Create the shared material for AnimatedInstancedMesh.
 * This material supports:
 * - Per-instance alpha, player color, tint, minimap mask
 * - Per-shape vertex colors
 * - Part-based animation via transform/opacity textures (set per-mesh)
 *
 * The animation textures are NOT baked into the material - each mesh sets its own
 * via onBeforeRender. This allows one material to be shared across all models.
 */
export function createAnimatedMeshMaterial(): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    side: DoubleSide,
    depthWrite: true,
    forceSinglePass: true,
  });

  material.customProgramCacheKey = () => "animatedInstanced";

  material.onBeforeCompile = (shader) => {
    addAnimatedInstanceShader(shader, material);
  };

  return material;
}
