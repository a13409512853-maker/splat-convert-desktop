// Shared by legacy v1/v2 recipes and export worker.
// Supports box, sphere, ellipsoid, cylinder, rect, ellipse, lasso, poly, brush.
const finiteArray = (x, n) =>
  Array.isArray(x) && x.length === n && x.every(Number.isFinite);

export function validate(r) {
  if (r?.version === 3) {
    if (!Array.isArray(r.objects) || r.objects.length === 0)
      throw Error("Invalid v3 editor recipe");
    return r;
  }
  if (
    ![1, 2].includes(r?.version) ||
    !Array.isArray(r.rules) ||
    r.rules.length > 256 ||
    !finiteArray(r.translation, 3) ||
    !finiteArray(r.rotation, 3) ||
    !(r.scale > 0 && Number.isFinite(r.scale))
  ) {
    throw Error("Invalid editor recipe");
  }
  for (const s of r.rules) {
    if (
      !["replace", "add", "subtract", "intersect"].includes(s.op) ||
      !["box", "sphere", "ellipsoid", "cylinder", "rect", "ellipse", "lasso", "poly", "brush"].includes(s.kind) ||
      !finiteArray(s.m, 16)
    ) {
      throw Error("Invalid selection");
    }
    if (
      ["rect", "ellipse", "lasso", "poly", "brush"].includes(s.kind) &&
      (!Array.isArray(s.path) ||
        s.path.length < 1 ||
        s.path.length > 4096 ||
        !s.path.every((p) => finiteArray(p, 2)) ||
        !(s.aspect > 0 && Number.isFinite(s.aspect)) ||
        !(s.radius >= 0 && Number.isFinite(s.radius)))
    ) {
      throw Error("Invalid stroke");
    }
  }
  return r;
}

export function compile(r) {
  validate(r);
  const rules = (r.rules || []).map((s) => {
    const m = s.m;
    const volume = ["box", "sphere", "ellipsoid", "cylinder"].includes(s.kind);
    const xs = s.path?.map((p) => p[0]) || [];
    const ys = s.path?.map((p) => p[1]) || [];
    const pad = s.kind === "brush" ? s.radius : 0;
    const x0 = Math.min(...xs) - pad / (s.aspect || 1);
    const x1 = Math.max(...xs) + pad / (s.aspect || 1);
    const y0 = Math.min(...ys) - pad;
    const y1 = Math.max(...ys) + pad;
    const ellCx = (x0 + x1) * 0.5;
    const ellCy = (y0 + y1) * 0.5;
    const ellRx = Math.max(1e-5, (x1 - x0) * 0.5);
    const ellRy = Math.max(1e-5, (y1 - y0) * 0.5);

    const isYUpCylinder = s.coordSystem === "y-up" || r.coordSystem === "y-up";

    function hit(x, y, z) {
      let a = m[0] * x + m[4] * y + m[8] * z + m[12];
      let b = m[1] * x + m[5] * y + m[9] * z + m[13];
      let c = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (volume) {
        if (s.kind === "sphere" || s.kind === "ellipsoid") return a * a + b * b + c * c <= 1;
        if (s.kind === "cylinder") {
          return isYUpCylinder
            ? a * a + c * c <= 1 && Math.abs(b) <= 1
            : a * a + b * b <= 1 && Math.abs(c) <= 1;
        }
        return Math.max(Math.abs(a), Math.abs(b), Math.abs(c)) <= 1;
      }
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w <= 0 || Math.abs(c) > w) return false;
      a /= w;
      b /= w;
      if (a < x0 || a > x1 || b < y0 || b > y1) return false;
      if (s.kind === "rect") return true;
      if (s.kind === "ellipse") {
        const dx = (a - ellCx) / ellRx;
        const dy = (b - ellCy) / ellRy;
        return dx * dx + dy * dy <= 1;
      }
      let inside = false;
      for (
        let i = 0, j = s.kind === "poly" || s.kind === "lasso" ? s.path.length - 1 : 0;
        i < s.path.length;
        j = i++
      ) {
        const [u, v] = s.path[i];
        const [h, k] = s.path[j];
        if (s.kind === "poly" || s.kind === "lasso") {
          if ((v > b) !== (k > b) && a < ((h - u) * (b - v)) / (k - v) + u)
            inside = !inside;
        } else {
          const dx = (h - u) * s.aspect;
          const dy = k - v;
          const px = (a - u) * s.aspect;
          const py = b - v;
          const t = Math.max(
            0,
            Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)),
          );
          if ((px - t * dx) ** 2 + (py - t * dy) ** 2 <= s.radius * s.radius)
            return true;
        }
      }
      return inside;
    }
    return { op: s.op, hit };
  });
  return (x, y, z) => {
    let yes =
      rules[0]?.op === "subtract" ||
      rules[0]?.op === "intersect" ||
      !rules.length;
    for (const { op, hit } of rules) {
      if (op === "replace") yes = hit(x, y, z);
      else if (op === "add") yes = yes || hit(x, y, z);
      else if (op === "subtract") yes = yes && !hit(x, y, z);
      else yes = yes && hit(x, y, z);
    }
    return yes;
  };
}
