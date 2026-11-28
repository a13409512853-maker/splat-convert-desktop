// Exercises the shipped EXE, not just the JS predicate. All outputs stay in the supplied test directory.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { layout, readExact } from "../windows/editor/ply.mjs";
const [exe, dir] = process.argv.slice(2).map((s) => path.resolve(s));
fs.mkdirSync(dir, { recursive: true });
const src = path.join(dir, "five.ply"),
  fields = [
    "x",
    "y",
    "z",
    "f_dc_0",
    "f_dc_1",
    "f_dc_2",
    "scale_0",
    "scale_1",
    "scale_2",
    "rot_0",
    "rot_1",
    "rot_2",
    "rot_3",
    "opacity",
  ];
const data = Buffer.alloc(5 * fields.length * 4);
for (let i = 0; i < 5; i++)
  [i - 2, 0, 0, 0.2, 0.3, 0.4, -2, -2, -2, 1, 0, 0, 0, 2].forEach((v, k) =>
    data.writeFloatLE(v, (i * fields.length + k) * 4),
  );
fs.writeFileSync(
  src,
  Buffer.concat([
    Buffer.from(
      "ply\nformat binary_little_endian 1.0\nelement vertex 5\n" +
        fields.map((k) => "property float " + k).join("\n") +
        "\nend_header\n",
    ),
    data,
  ]),
);
function convert(input, name, recipe) {
  const output = path.join(dir, name),
    ext = path.extname(output),
    job = path.join(dir, "job.json");
  fs.writeFileSync(
    job,
    JSON.stringify({
      JobId: "test-editor-" + Date.now(),
      Mode: "merge",
      ConflictPolicy: "overwrite",
      Inputs: [
        {
          Id: "one",
          StoredPath: input,
          AuthorizedExternal: true,
          Ops: recipe
            ? [
                {
                  Flag: "--scene-edit",
                  Value: JSON.stringify(recipe),
                  Enabled: true,
                },
              ]
            : [],
        },
      ],
      Profiles: [
        {
          Id: "p",
          FormatSuffix: ext,
          OutputPath: output,
          Device: "cpu",
          Keep: 100,
        },
      ],
    }),
  );
  let r = spawnSync(exe, ["run", "--job", job], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr + " " + r.stdout);
  return output;
}
const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const recipe = {
  version: 1,
  rules: [
    {
      kind: "rect",
      op: "replace",
      m: id,
      path: [
        [-1, -1],
        [1, 1],
      ],
      radius: 0,
      aspect: 1,
    },
    { kind: "sphere", op: "subtract", m: id.map((v, i) => (i === 0 ? 4 : v)) },
  ],
  translation: [3, 2, 0],
  rotation: [0, 0, 90],
  scale: 2,
};
const sog = convert(src, "packed.sog", null);
const boundary = convert(sog, "boundary.ply", recipe);
const bfd = fs.openSync(boundary, "r");
try {
  assert.equal(layout(bfd).count, 1);
} finally {
  fs.closeSync(bfd);
}
recipe.rules[0].m[0] = 0.9;
for (const input of [src, sog]) {
  let out = convert(input, path.basename(input) + ".edited.ply", recipe),
    fd = fs.openSync(out, "r");
  try {
    let l = layout(fd);
    assert.equal(l.count, 2);
    let b = Buffer.alloc(l.count * l.stride);
    readExact(fd, b, b.length, l.start);
    let rows = Array.from({ length: 2 }, (_, i) => [
      l.accessor("x")(b, i * l.stride),
      l.accessor("y")(b, i * l.stride),
    ]).sort((a, b) => a[1] - b[1]);
    assert(rows.every((p) => Math.abs(p[0] + 3) < 0.001));
    assert(Math.abs(rows[0][1] + 4) < 0.001 && Math.abs(rows[1][1]) < 0.001);
    console.log("PASS", path.basename(input), "selection and world TRS:", rows);
  } finally {
    fs.closeSync(fd);
  }
}
