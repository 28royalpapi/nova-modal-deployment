import chromium from "@sparticuz/chromium-min";
import { chromium as playwright } from "playwright-core";

const PACK_URL = process.env.NOVA_CHROMIUM_PACK_URL ||
  "https://github.com/Sparticuz/chromium/releases/download/v138.0.2/chromium-v138.0.2-pack.x64.tar";

let browser;
try {
  const executablePath = await chromium.executablePath(PACK_URL);
  browser = await playwright.launch({
    args: chromium.args, executablePath, headless: true,
    defaultViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    timeout: 25000,
  });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(18000);
  await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 18000 });
  const title = await page.title();
  if (!title.includes("Example Domain")) throw new Error("Unexpected title: " + title);
  const screenshot = await page.screenshot({ type: "png", timeout: 8000 });
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  if (screenshot.length < 1000 || pdf.length < 1000) throw new Error("Screenshot/PDF output too small");
  console.log(JSON.stringify({ ok: true, browser: await browser.version(), title, screenshot_bytes: screenshot.length, pdf_bytes: pdf.length }));
} finally {
  if (browser) await browser.close();
}
