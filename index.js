// Imports
import express from "express";
import cron from "node-cron";
import fs from "fs";
import { chromium } from "playwright";

// ========= ENV =========
const env = {
  PORT: process.env.PORT || "8080",

  // Betriebsfenster (UTC)
  WINDOW_START: process.env.WINDOW_START || "00:00",
  WINDOW_END: process.env.WINDOW_END || "23:59",
  HEARTBEAT_EVERY_MIN: Number(process.env.HEARTBEAT_EVERY_MIN || "30"),
  MAX_PER_DAY: Number(process.env.MAX_PER_DAY || "999999"),

  // AlgosOne Login
  DASH_URL: process.env.DASH_URL || "https://app.algosone.ai/dashboard",
  LOGIN_URL: process.env.LOGIN_URL || "https://app.algosone.ai/login",
  LOGIN_METHOD: (process.env.LOGIN_METHOD || "password").toLowerCase(), // "password" | "google"
  EMAIL: process.env.EMAIL || "",
  PASSWORD: process.env.PASSWORD || "",

  // optionaler HTTP-Auth
  AUTH_TOKEN: process.env.AUTH_TOKEN || ""
};

const STORAGE_PATH = "/app/storageState.json"; // gespeicherte Cookies/Sessions
const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

if (process.env.STORAGE_STATE_B64 && !fs.existsSync(STORAGE_PATH)) {
  fs.writeFileSync(STORAGE_PATH, Buffer.from(process.env.STORAGE_STATE_B64, "base64"));
}

// ========= Utils =========
let approvesToday = 0;
let busy = false;

const toMin = s => { const [h,m]=s.split(":").map(Number); return h*60+m; };
const inWindow = () => {
  const d = new Date(); const cur = d.getUTCHours()*60 + d.getUTCMinutes();
  return cur >= toMin(env.WINDOW_START) && cur <= toMin(env.WINDOW_END);
};

async function withCtx(fn){
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const contextOptions = {
    userAgent: DESKTOP_UA,
    viewport: { width: 1366, height: 820 },
    deviceScaleFactor: 1
  };
  if (fs.existsSync(STORAGE_PATH)) contextOptions.storageState = STORAGE_PATH;

  const ctx = await browser.newContext(contextOptions);
  const page = await ctx.newPage();
  try {
    const r = await fn(page);
    try { await ctx.storageState({ path: STORAGE_PATH }); } catch {}
    await browser.close();
    return r;
  } catch (e) {
    await browser.close();
    throw e;
  }
}

function onLoginUrl(page) {
  const u = page.url();
  return /app\.algosone\.ai\/login/i.test(u) || /accounts\.google\.com/i.test(u);
}

// ========= Login =========
async function loginWithPassword(page) {
  await page.goto(env.LOGIN_URL, { waitUntil: "networkidle", timeout: 90000 });
  await page.locator('input[type="email"]').fill(env.EMAIL);
  await page.locator('input[type="password"]').fill(env.PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/app\.algosone\.ai\/(dash|dashboard)/i, { timeout: 90000 });
}

async function loginWithGoogle(page) {
  await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.getByRole("button", { name: /google|continue with google|sign in with google|weiter mit google/i }).click();
  await page.getByRole("textbox", { name: /email|phone|e-mail/i }).fill(env.EMAIL);
  await page.getByRole("button", { name: /next|weiter/i }).click();
  await page.getByRole("textbox", { name: /password|passwort/i }).fill(env.PASSWORD);
  await page.getByRole("button", { name: /next|weiter/i }).click();
  await page.waitForURL(/app\.algosone\.ai\/(dash|dashboard)/i, { timeout: 90000 });
}

async function ensureOnDashboard(page) {
  await page.goto(env.DASH_URL, { waitUntil: "networkidle", timeout: 90000 });
  if (!onLoginUrl(page)) return true;

  if (!env.EMAIL || !env.PASSWORD) return false;
  try {
    if (env.LOGIN_METHOD === "google") await loginWithGoogle(page);
    else await loginWithPassword(page);
  } catch {
    return false;
  }
  return !onLoginUrl(page);
}

// ========= Banner/Confirm =========
async function dismissOverlays(page) {
  const candidates = [
    page.getByRole("button", { name: /accept all|accept|agree|got it|okay|ok/i }).first(),
    page.locator('button:has-text("Accept")').first(),
    page.locator('button:has-text("I Agree")').first(),
    page.getByRole("button", { name: /close|schließen|dismiss/i }).first()
  ];
  for (const c of candidates) {
    try {
      if (await c.count() > 0) {
        await c.click().catch(()=>{});
        await page.waitForTimeout(150);
      }
    } catch {}
  }
}

async function maybeConfirm(page) {
  const dlg = page.getByRole("dialog");
  if (await dlg.count() === 0) return;
  const btn = dlg.getByRole("button", { name: /^(confirm|yes|ok|continue)$/i }).first();
  if (await btn.count() > 0) {
    await btn.click().catch(()=>{});
    await page.waitForTimeout(150);
  }
}

// ========= Approve =========
async function tryApproveOnDashboard(page) {
  await dismissOverlays(page);

  // 1) Direkt sichtbarer Approve
  let btn = page.locator('button:has-text("Approve"), button:has-text("Genehmigen")').first();
  if (await btn.count() > 0) {
    await btn.click();
    await maybeConfirm(page);
    return true;
  }

  // 2) (Optional) „New actions available“-Leiste öffnen
  const newActions = page.locator("div,button,a").filter({ hasText: /new actions available/i }).first();
  if (await newActions.count() > 0) {
    await newActions.click().catch(()=>{});
    await page.waitForTimeout(1200);
    btn = page.locator('button:has-text("Approve"), button:has-text("Genehmigen")').first();
    if (await btn.count() > 0) {
      await btn.click();
      await maybeConfirm(page);
      return true;
    }
  }

  return false;
}

async function approveOne() {
  if (!inWindow()) return { ok:false, reason:"OUTSIDE_WINDOW" };
  if (approvesToday >= env.MAX_PER_DAY) return { ok:false, reason:"DAILY_LIMIT" };
  if (busy) return { ok:false, reason:"BUSY" };

  busy = true;
  try {
    return await withCtx(async (page) => {
      const logged = await ensureOnDashboard(page);
      if (!logged) return { ok:false, reason:"LOGIN_REQUIRED" };

      for (let i = 0; i < 5; i++) {
        const ok = await tryApproveOnDashboard(page);
        if (ok) { approvesToday++; return { ok:true, reason: i===0 ? "APPROVED_DIRECT" : "APPROVED_AFTER_REFRESH" }; }
        await page.reload({ waitUntil: "networkidle" });
      }
      return { ok:false, reason:"NO_BUTTON" };
    });
  } catch (e) {
    console.error("approveOne error:", e);
    return { ok:false, reason:"ERROR", msg: e.message };
  } finally {
    busy = false;
  }
}

// ========= Heartbeat =========
async function heartbeat(){
  if (!inWindow()) return;
  try {
    await withCtx(async (page) => {
      await ensureOnDashboard(page); // relogin falls nötig
      await page.waitForTimeout(300);
    });
  } catch(e){ console.error("Heartbeat:", e.message); }
}
cron.schedule(`*/${env.HEARTBEAT_EVERY_MIN} * * * *`, heartbeat, { timezone: "UTC" });
cron.schedule("0 0 * * *", () => { approvesToday = 0; }, { timezone: "UTC" });

// ========= HTTP Endpoints =========
const app = express();
function checkAuth(req,res,next){
  if (!env.AUTH_TOKEN) return next();
  const token = req.headers["x-auth"] || req.query.auth;
  if (token !== env.AUTH_TOKEN) return res.status(401).json({ ok:false, reason:"UNAUTHORIZED" });
  next();
}
app.get("/approve", checkAuth, async (_req,res)=> res.json(await approveOne()));
app.get("/login-status", checkAuth, async (_req,res)=>{
  try{
    const r = await withCtx(async page=>{
      await page.goto(env.DASH_URL, { waitUntil:"domcontentloaded", timeout: 60000 });
      if (onLoginUrl(page)) {
        const ok = await ensureOnDashboard(page);
        return ok ? "OK" : "LOGIN_REQUIRED";
      }
      return "OK";
    });
    res.json({ ok:true, status:r });
  } catch(e){ res.json({ ok:false, error:e.message }); }
});
app.get("/health", (_req,res)=> res.json({
  ok:true,
  window:`${env.WINDOW_START}-${env.WINDOW_END} UTC`,
  hbEveryMin: env.HEARTBEAT_EVERY_MIN
}));

// Fast Webhook: Antwort sofort, Approve läuft im Hintergrund
app.post("/hook/telegram", checkAuth, express.json({ limit: "64kb" }), async (req, res) => {
  // optional: Log der Nachricht, schadet nicht
  try {
    const msg = (req.body && req.body.message) ? String(req.body.message) : "";
    console.log("Signal received:", msg.slice(0, 120));
  } catch {}

  // Sofort antworten (nicht auf Playwright warten)
  res.json({ ok: true, queued: true });

  // Im Hintergrund ausführen
  approveOne()
    .then(r => console.log("approve-async result:", r))
    .catch(e => console.error("approve-async error:", e.message));
});

// ========= Start =========
app.listen(Number(env.PORT), () => {
  console.log(`Approver Service up on ${env.PORT} | window ${env.WINDOW_START}-${env.WINDOW_END} UTC`);
});
