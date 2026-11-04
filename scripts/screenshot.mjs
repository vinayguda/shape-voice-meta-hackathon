import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT || "3000";
const base = `http://127.0.0.1:${port}`;
const chrome = process.env.CHROME_PATH || "/usr/local/bin/google-chrome";

const child = spawn(process.execPath, ["server/index.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), META_MODEL: "muse-spark-1.3" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

async function waitForHealth() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("server did not start");
}

await waitForHealth();
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(base, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => /pain/i.test(document.querySelector("#question")?.textContent || ""));
  await page.evaluate(() => document.fonts.ready);
  const lines = await page.evaluate(async () => {
    const response = await fetch("/api/sample");
    const data = await response.json();
    return data;
  });
  await page.$eval("#context-notes", (el, value) => { el.value = value; }, lines.context);
  await page.click("#context-load");
  await page.waitForSelector("#context-chip:not([hidden])");

  async function answer(text) {
    const before = await page.$eval("#transcript", (el) => el.childElementCount);
    await page.$eval("#composer", (el, value) => { el.value = value; }, text);
    await page.click("#send");
    await page.waitForFunction((count) => {
      const node = document.querySelector("#transcript");
      return node && node.childElementCount > count && !document.body.classList.contains("is-busy");
    }, {}, before);
  }

  for (let i = 0; i < 3; i += 1) await answer(lines.turns[i]);
  await page.evaluate(() => {
    const sheet = document.querySelector(".sheet");
    if (sheet) sheet.scrollTop = 0;
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await page.screenshot({ path: path.join(root, "docs/screenshot-mid.png") });

  for (let i = 3; i < lines.turns.length; i += 1) await answer(lines.turns[i]);
  await page.evaluate(() => {
    const sheet = document.querySelector(".sheet");
    if (sheet) sheet.scrollTop = 0;
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await page.screenshot({ path: path.join(root, "docs/screenshot-ready.png") });
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("screenshots ok");
  }
} finally {
  await browser.close();
  child.kill("SIGTERM");
}
