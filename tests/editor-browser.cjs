// Headless test only. Intercept local assets in the test process; no listening server.
const { chromium } = require("playwright"),
  fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict");
(async () => {
  const [bin, out] = process.argv.slice(2),
    dir = path.resolve(__dirname, "../windows/editor");
  const browser = await chromium.launch({
    executablePath: process.env.TEST_CHROMIUM || undefined,
    args: ["--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage({
        viewport: { width: 1060, height: 720 },
      }),
      errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error(e.message);
    });
    page.on("console", (m) => {
      if (m.type() === "error") {
        errors.push(m.text());
        console.error(m.text());
      }
    });
    await page.route("https://editor.splat.invalid/**", async (r) => {
      const k = new URL(r.request().url()).pathname.slice(1);
      const f = path.join(dir, k);
      if (!fs.existsSync(f)) return r.fulfill({ status: 404 });
      await r.fulfill({
        body: fs.readFileSync(f),
        contentType: /\.m?js$/.test(k)
          ? "text/javascript"
          : k.endsWith(".css")
            ? "text/css"
            : k.endsWith(".svg")
              ? "image/svg+xml"
              : "text/html",
      });
    });
    await page.addInitScript(() => {
      window.chrome ??= {};
      window.chrome.webview = {
        addEventListener: (k, f) => (window.receive = f),
        postMessage: (s) => (window.lastMessage = s),
      };
    });
    await page.goto("https://editor.splat.invalid/index.html");
    await page.waitForFunction(() => window.lastMessage === "ready", null, {
      timeout: 8000,
    });
    await page.evaluate(
      (sample) => window.receive({ data: { sample, low: false } }),
      fs.readFileSync(bin).toString("base64"),
    );
    await page.waitForFunction(() =>
      document.querySelector("#metric").textContent.includes("/"),
    );
    const view = page.locator("#canvas");
    const before = await view.screenshot();
    await page.mouse.move(200, 280);
    await page.mouse.down();
    await page.mouse.move(340, 310, { steps: 7 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.notDeepEqual(await view.screenshot(), before);
    await page.screenshot({ path: path.join(out, "editor-desktop.png") });
    await page.keyboard.press("d");
    await page.waitForFunction(() =>
      document.querySelector("#metric").textContent.includes("泼溅"),
    );
    await page.screenshot({ path: path.join(out, "editor-splat.png") });
    await page.keyboard.press("p");
    await page.keyboard.press("b");
    await page.mouse.move(155, 170);
    await page.mouse.down();
    await page.mouse.move(530, 439);
    await page.mouse.up();
    await page.waitForFunction(() =>
      document.querySelector("#summary").textContent.includes("1 个选区"),
    );
    await page.keyboard.press("7");
    await page.keyboard.press("5");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+y");
    await page.click("#apply");
    let recipe = await page.evaluate(() => JSON.parse(lastMessage.slice(6)));
    assert.deepEqual(
      recipe.rules.map((r) => [r.kind, r.op]),
      [
        ["rect", "replace"],
        ["sphere", "add"],
      ],
    );
    fs.writeFileSync(path.join(out, "ui-recipe.json"), JSON.stringify(recipe));
    await page.keyboard.press('8');await page.keyboard.press('l');
    for(const [x,y] of [[230,230],[320,235],[285,305]]) await page.mouse.click(x,y);
    await page.keyboard.press('Enter');await page.keyboard.press('9');await page.keyboard.press('v');
    await page.mouse.move(240,210);await page.mouse.down();await page.mouse.move(340,260,{steps:8});await page.mouse.up();
    await page.keyboard.press('6');await page.keyboard.press('4');await page.keyboard.press('t');await page.keyboard.press('Enter');await page.click('#apply');
    assert.deepEqual((await page.evaluate(()=>JSON.parse(lastMessage.slice(6)))).rules.slice(2).map(r=>[r.kind,r.op]),[['poly','subtract'],['brush','intersect'],['box','replace']]);
    await page.setViewportSize({ width: 390, height: 680 });
    await page.screenshot({ path: path.join(out, "editor-small.png") });
    assert(await view.evaluate((c) => c.width > 180 && c.height > 400));
    let overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    assert(!overflow);
    assert.deepEqual(errors, []);
    console.log(
      "PASS desktop/mobile layout, orbit, splat, projection, rect/sphere composition, undo/redo, apply.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
