# GPU-Only 2D Animation System (Two-Texture Variant)

## Goal

Support **GPU-only animation** for instanced 2D models using:

- **Transform texture**: `tx, ty, rot, scale`
- **Opacity texture**: `opacity`
- All animation authored offline and baked
- Zero per-instance CPU animation work

---

## 1. Authoring Format (Input)

### 1.1 Model Definition

Each model consists of **parts**.

```json
{
  "parts": [
    {
      "name": "armL",
      "pivot": [0.12, 0.45],
      "vertices": [ ... ], 
      "indices": [ ... ]
    }
  ]
}
```

**Requirements**

- Vertices are in **local part space**, relative to `pivot`
- Each vertex gets a `partID` (integer index into `parts[]`)

---

### 1.2 Animation Definition

```json
{
  "fps": 60,
  "clips": {
    "idle": {
      "duration": 1.0,
      "parts": {
        "armL": {
          "tx": [{ "t": 0.0, "v": 0.0 }],
          "ty": [{ "t": 0.0, "v": 0.0 }],
          "rot": [{ "t": 0.0, "v": 0.0 }],
          "scale": [{ "t": 0.0, "v": 1.0 }],
          "opacity": [{ "t": 0.0, "v": 1.0 }]
        }
      }
    }
  }
}
```

**Rules**

- All channels optional
- Missing channels use defaults:

  - `tx = 0`
  - `ty = 0`
  - `rot = 0`
  - `scale = 1`
  - `opacity = 1`
- Curves may be step-like or continuous

---

## 2. Baking Pipeline (Offline)

### 2.1 Sampling

- Fixed sample count `S` (e.g. 64)
- Sample time:

```
t = (sampleIndex / (S - 1)) * clip.duration
```

---

### 2.2 Bake Transform Texture

**Layout**

```
width  = S
height = partCount × clipCount
format = RGBA32F
```

**Channels**

```
R = tx
G = ty
B = rot (radians)
A = scale
```

**Row index**

```
row = clipIndex * partCount + partIndex
```

---

### 2.3 Bake Opacity Texture

**Layout**

```
width  = S
height = partCount × clipCount
format = R16F or R32F
```

**Channel**

```
R = opacity
```

---

### 2.4 Output Artifacts

- `geometry.json` (triangles + partID attribute)
- `transformAnim.png` (or .bin Float32Array)
- `opacityAnim.png`
- `animationMeta.json`

```json
{
  "sampleCount": 64,
  "partCount": 12,
  "clips": {
    "idle": { "index": 0 },
    "walk": { "index": 1 }
  }
}
```

---

## 3. three.js Runtime Class

### 3.1 Class Definition

```ts
class AnimatedInstancedMesh extends THREE.InstancedMesh
```

---

### 3.2 Geometry Requirements

- Attributes:

  - `position`
  - `partID` (float)
- Geometry is static

---

### 3.3 Per-Instance Attributes

```ts
InstancedBufferAttribute:
-animClip(float) -
  animPhase(float) -
  animSpeed(float);
```

**Set once per instance**

---

### 3.4 Uniforms

```ts
uniform float uTime;
uniform sampler2D uTransformTex;
uniform sampler2D uOpacityTex;
uniform float uSampleCount;
uniform float uPartCount;
```

---

## 4. Shaders

---

### 4.1 Vertex Shader (Core Logic)

```glsl
float t = fract((uTime * animSpeed + animPhase));
float sampleX = t * (uSampleCount - 1.0) / uSampleCount;

float row = animClip * uPartCount + partID;
float sampleY = (row + 0.5) / textureHeight;

vec4 tf = texture(uTransformTex, vec2(sampleX, sampleY));

vec2 p = position.xy;

// scale
p *= tf.a;

// rotate
float c = cos(tf.b);
float s = sin(tf.b);
p = mat2(c, -s, s, c) * p;

// translate
p += tf.rg;

// instance transform
vec4 world = instanceMatrix * vec4(p, 0.0, 1.0);

gl_Position = projectionMatrix * modelViewMatrix * world;
```

---

### 4.2 Opacity Sampling (Vertex or Fragment)

**Vertex Shader**

```glsl
vOpacity = texture(uOpacityTex, vec2(sampleX, sampleY)).r;
```

---

### 4.3 Fragment Shader

```glsl
vec4 color = texture(diffuseMap, uv);
color.rgb *= vOpacity;
color.a   *= vOpacity;
gl_FragColor = color;
```

Enable **premultiplied alpha blending**.

---

## 5. Runtime Update

### Per Frame

```ts
material.uniforms.uTime.value = timeSeconds;
```

No per-instance updates.

---

## 6. Guarantees

- Zero CPU animation cost
- Fully instanced
- Author-driven animation
- Supports smooth or step opacity
- Easily extended with new channels

---

## End State

A **single generic shader** interprets all animations. Adding new animations
requires **only new baked textures**, not code changes.
