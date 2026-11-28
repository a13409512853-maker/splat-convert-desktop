#!/usr/bin/env node
/**
 * Automated Module Boundary, Import Integrity, Cycle & Syntax Check (002-A Step 3).
 * Verifies:
 *  1. Every JS/MJS under windows/editor/ passes `node --check`.
 *  2. Every relative JS import and CSS @import target resolves to an existing file.
 *  3. Zero circular import cycles across windows/editor/.
 *  4. Pure domain layer (`windows/editor/domain/*.mjs` except `three-preview-adapter.mjs`)
 *     has ZERO imports of Three.js / PlayCanvas / DOM globals / WebGL.
 *  5. Zero active code references to archived `editor-resplat` or `pcui`.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const editorDir = path.join(repoRoot, "windows", "editor");

function walk(dir, exts, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "vendor" || ent.name === "node_modules") continue;
      walk(full, exts, out);
    } else if (exts.some((ext) => ent.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const jsFiles = walk(editorDir, [".js", ".mjs"]);
const cssFiles = walk(editorDir, [".css"]);

const errors = [];
const graph = new Map();
const lineCounts = {};

// 1. Syntax + JS import extraction + active legacy reference scan
const importRe = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
const dynamicImportRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

for (const file of jsFiles) {
  const rel = path.relative(editorDir, file).replace(/\\/g, "/");
  const src = fs.readFileSync(file, "utf8");
  lineCounts[rel] = src.split(/\r?\n/).length;

  // Syntax validation via node --check
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    errors.push(`Syntax error in ${rel}: ${err.stderr?.toString() || err.message}`);
  }

  // Gather relative dependencies
  const deps = [];
  for (const re of [importRe, dynamicImportRe]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1];
      if (spec.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), spec);
        if (!fs.existsSync(resolved)) {
          errors.push(`Broken relative import in ${rel}: "${spec}" -> ${resolved}`);
        } else {
          deps.push(path.relative(editorDir, resolved).replace(/\\/g, "/"));
        }
      } else {
        deps.push(`ext:${spec}`);
      }
    }
  }
  graph.set(rel, deps);

  // Strict domain boundary check
  if (rel.startsWith("domain/") && rel !== "domain/three-preview-adapter.mjs") {
    for (const d of deps) {
      if (d === "ext:three" || d.includes("three") || d.includes("playcanvas") || d.includes("pcui")) {
        errors.push(`Domain isolation violation in ${rel}: forbidden dependency "${d}"`);
      }
      if (!d.startsWith("domain/") && !d.startsWith("ext:node:")) {
        errors.push(`Domain layer ${rel} must not import outside domain/: found "${d}"`);
      }
    }
    const domBan = /\b(document\.(getElementById|querySelector|createElement)|window\.|WebGL2RenderingContext|HTMLCanvasElement)\b/;
    if (domBan.test(src)) {
      errors.push(`Domain isolation violation in ${rel}: direct DOM/WebGL reference detected`);
    }
  }

  // Zero active editor-resplat / pcui imports
  if (/\bfrom\s+["'][^"']*(editor-resplat|pcui)[^"']*["']/i.test(src)) {
    errors.push(`Forbidden legacy dependency in ${rel}`);
  }
}

// 2. CSS @import resolution check
const cssImportRe = /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)\s*;/g;
for (const file of cssFiles) {
  const rel = path.relative(editorDir, file).replace(/\\/g, "/");
  const src = fs.readFileSync(file, "utf8");
  lineCounts[rel] = src.split(/\r?\n/).length;
  cssImportRe.lastIndex = 0;
  let m;
  while ((m = cssImportRe.exec(src)) !== null) {
    const spec = m[1];
    if (spec.startsWith(".")) {
      const resolved = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(resolved)) {
        errors.push(`Broken CSS @import in ${rel}: "${spec}"`);
      }
    }
  }
}

// 3. Circular import detection (DFS 3-color)
const color = new Map(); // 0=unvisited, 1=visiting, 2=done
const stack = [];
function dfs(node) {
  color.set(node, 1);
  stack.push(node);
  for (const dep of graph.get(node) || []) {
    if (dep.startsWith("ext:")) continue;
    const c = color.get(dep) || 0;
    if (c === 1) {
      const idx = stack.indexOf(dep);
      errors.push(`Circular import detected: ${[...stack.slice(idx), dep].join(" -> ")}`);
    } else if (c === 0 && graph.has(dep)) {
      dfs(dep);
    }
  }
  stack.pop();
  color.set(node, 2);
}
for (const node of graph.keys()) {
  if (!color.get(node)) dfs(node);
}

const summary = {
  ok: errors.length === 0,
  jsFilesChecked: jsFiles.length,
  cssFilesChecked: cssFiles.length,
  domainPureFiles: [...graph.keys()].filter((k) => k.startsWith("domain/") && k !== "domain/three-preview-adapter.mjs"),
  keyLineCounts: {
    "viewport.js": lineCounts["viewport.js"],
    "cloud.js": lineCounts["cloud.js"],
    "shaders/splat-shaders.js": lineCounts["shaders/splat-shaders.js"],
    "measure/measure-manager.js": lineCounts["measure/measure-manager.js"],
    "measure/measure-card-ui.js": lineCounts["measure/measure-card-ui.js"],
    "editor.css": lineCounts["editor.css"],
    cssSubModules: cssFiles.filter((f) => f.includes(`${path.sep}styles${path.sep}`)).length,
  },
  errors,
};

console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exit(1);
