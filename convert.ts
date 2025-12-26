#!/usr/bin/env -S deno run -A
/**
 * CLI to convert .estme files to .estb binary format.
 * Usage: deno run -A convert.ts input.estme output.estb
 */

import { exportBinary } from "./src/exportBinary.ts";

const [inputPath, outputPath] = Deno.args;

if (!inputPath || !outputPath) {
  console.error("Usage: deno run -A convert.ts input.estme output.estb");
  Deno.exit(1);
}

const json = await Deno.readTextFile(inputPath);
const data = JSON.parse(json);

const binary = exportBinary(data.paths, data.groups, data.animationClips ?? []);
await Deno.writeFile(outputPath, new Uint8Array(binary));

console.log(`Converted ${inputPath} -> ${outputPath} (${binary.byteLength} bytes)`);
