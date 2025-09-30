// ---------- Imports ----------
import express from "express";
import cron from "node-cron";
import fs from "fs";
import { chromium } from "playwright";

// ---------- ENV ----------
const env = {
  PORT: process.env.PORT || "8080",

  // Fenster (UTC)
  WINDOW_START: process.env.WINDOW_START || "00:00",
  WINDOW_END: process.env.WINDOW_END || "23:59",
  HEARTBEAT_EVERY_MIN: Number(process.env.HEARTBEAT_EVERY_MIN || "10"), // wird nicht mehr genutzt
  HEARTBEAT_MIN_MIN: Number(process.env.HEARTBEAT_MIN_MIN || "7"),
  HEARTBEAT_MAX_MIN: Number(process.env.HEARTBEAT_MAX_MIN || "12"),
  MAX_PER_DAY: Number(process.env.MAX_PER_DAY || "999999"),

  // AlgosOne
  DASH_URL: process.env.DASH_URL || "https://app.algosone.ai/dashboard",
  LOGIN_URL: process.env.LOGIN_URL || "https://app.algosone.ai/login",
  LOGIN_METHOD: (process.env.LOGIN_METHOD || "password").toLowerCase(), // "password" | "google"
  EMAIL: process.env.EMAIL || "",
  PASSWORD: process.env.PASSWORD || "",

  // HTTP-Auth (optional)
  AUTH_TOKEN: process.env.AUTH_TOKEN || "",

  // Zeitlimits (Feintuning)
  FAST_LOAD_MS: Number(process.env.FAST_LOAD_MS || "3000"),   // Wartezeit für FAST goto
  CLICK_WAIT_MS: Number(process.env.CLICK_WAIT_MS || "1500")   // kleine Pausen nach Klicks
};

// ---------- Helpers ----------
const STORAGE_PATH = "/app/storageState.json";
const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

let approvesToday = 0;
let busy = false;

const toMin = s => { const [h,m]=s.split(":").map(Number); return h*60+m; };
const inWindow = () => {
  const d = new Date(); const cur = d.getUTCHours()*60 + d.getUTCMinutes();
  return cur >= toMin(env.WINDOW_START) && cur <= toMin(env.WINDOW_END);
};

function onLoginUrl(page) {
  const u = page.url();
  return /app\.algosone\.ai\/login/i.test(u) || /accounts\.google\.com/i.test(u);
}
function logHere(page, tag){ console.log(`[${tag}] url= ${page.url()}`); }

// ---------- Singleton-Browser ----------
let browserP = null;
let ctx = null;

async function getCtx() {
  if (!browserP) {
    browserP = chromium.launch({ headless: true, args: ["--no-sandbox"] });
  }
  const browser = await browserP;

  if (!ctx) {
    const options = {
      userAgent: DESKTOP_UA,
      viewport: { width: 1366, height: 820 },
    };
    if (fs.existsSync(STORAGE_PATH)) options.storageState = STORAGE_PATH;
    ctx = await browser.newContext(options);
  }
  return ctx;
}

async function withCtx(fn) {
  const context = await getCtx();
  const page = await context.newPage();
  try {
    const r = await fn(page);
    try { await context.storageState({ path: STORAGE_PATH }); } catch {}
    return r;
  } finally {
    try { await page.close(); } catch {}
  }
}

// ---------- Overlays / Confirm ----------
async function dismissOverlays(page) {
  const candidates = [
    page.getByRole("button", { name: /accept all|accept|agree|got it|okay|ok|verstanden|zustimmen/i }).first(),
    page.locator('button:has-text("Accept")').first(),
    page.locator('button:has-text("I Agree")').first(),
    page.getByRole("button", { name: /close|schließen|dismiss/i }).first(),
    page.locator('[data-testid="cookie-policy-link"]').first()
  ];
  for (const c of candidates) {
    try {
      if (await c.count() > 0) {
        await c.click({ timeout: 1000 }).catch(()=>{});
        await page.waitForTimeout(100);
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
    await page.waitForTimeout(200);
  }
}

// ---------- Login ----------
async function loginWithPassword(page) {
  await page.goto(env.LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await dismissOverlays(page).catch(()=>{});
  logHere(page, "loginPw:start");

  const email =
    page.getByLabel(/email/i)
      .or(page.getByPlaceholder(/email|e-mail/i))
      .or(page.locator('input[type="email"]'))
      .first();
  await email.waitFor({ state: "visible", timeout: 20000 });
  await email.fill(env.EMAIL);

  const pass =
    page.getByLabel(/password|passwort/i)
      .or(page.getByPlaceholder(/password|passwort/i))
      .or(page.locator('input[type="password"]'))
      .first();
  await pass.waitFor({ state: "visible", timeout: 20000 });
  await pass.fill(env.PASSWORD);

  const submit =
    page.getByRole("button", { name: /sign in|log in|anmelden|login|continue/i }).first()
      .or(page.locator('button[type="submit"]')).first()
      .or(page.locator('button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Anmelden"), button:has-text("Login")')).first();

  await submit.click({ timeout: 20000 }).catch(async () => {
    await pass.press("Enter");
  });

  await page.waitForLoadState("networkidle", { timeout: 90000 });
  await dismissOverlays(page).catch(()=>{});
  logHere(page, "loginPw:afterSubmit");
  await page.waitForURL(/app\.algosone\.ai\/(dash|dashboard)/i, { timeout: 90000 }).catch(()=>{});
}

async function loginWithGoogle(page) {
  await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await dismissOverlays(page).catch(()=>{});
  const gBtn = page.getByRole("button", { name: /google|continue with google|sign in with google|weiter mit google/i }).first();
  await gBtn.click({ timeout: 20000 });

  await page.waitForURL(/accounts\.google\.com/i, { timeout: 90000 });
  await page.getByRole("textbox", { name: /email|phone|e-mail/i }).fill(env.EMAIL);
  await page.getByRole("button", { name: /next|weiter/i }).click();

  await page.getByRole("textbox", { name: /password|passwort/i }).fill(env.PASSWORD);
  await page.getByRole("button", { name: /next|weiter/i }).click();

  await page.waitForURL(/app\.algosone\.ai\/(dash|dashboard)/i, { timeout: 90000 });
  await dismissOverlays(page).catch(()=>{});
}

async function ensureOnDashboard(page) {
  await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS });
  await dismissOverlays(page).catch(()=>{});
  logHere(page, "ensure:afterGoto");

  if (!onLoginUrl(page)) return true;

  await page.goto(env.LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(()=>{});
  await dismissOverlays(page).catch(()=>{});
  logHere(page, "ensure:onLogin");

  if (!env.EMAIL || !env.PASSWORD) return false;

  try {
    if (env.LOGIN_METHOD === "google") await loginWithGoogle(page);
    else await loginWithPassword(page);
  } catch (e) {
    console.log("ensure:login error:", e.message || e);
    return false;
  }

  await dismissOverlays(page).catch(()=>{});
  logHere(page, "ensure:afterLogin");
  return !onLoginUrl(page);
}

// ---------- Approve (verbessert) ----------
async function tryApproveOnDashboard(page) {
  // Clean + top
  await dismissOverlays(page).catch(()=>{});
  await page.evaluate(() => window.scrollTo(0, 0)).catch(()=>{});
  await page.waitForTimeout(120);

  // Falls das blaue Ribbon existiert, zuerst öffnen
  const ribbon = page.locator("div,button,a").filter({ hasText: /new actions available|actions available/i }).first();
  if (await ribbon.count() > 0) {
    await ribbon.click().catch(()=>{});
    await page.waitForTimeout(600);
  }

  // Auf 1-click-trade Bereich einschränken, wenn vorhanden
  const oneClick = page.locator("section,div,article").filter({ hasText: /1\s*[-]?\s*click\s*trade/i }).first();
  const scope = (await oneClick.count()) > 0 ? oneClick : page;

  // Helfer: klicke das erste sichtbare/aktivierte Element aus der Liste
  async function clickFirstVisible(cands) {
    for (const loc of cands) {
      const n = await loc.count();
      if (!n) continue;
      for (let i = 0; i < Math.min(n, 8); i++) {
        const el = loc.nth(i);
        try {
          if (await el.isVisible() && await el.isEnabled()) {
            await el.click({ timeout: 1500 });
            await maybeConfirm(page);
            await page.waitForTimeout(env.CLICK_WAIT_MS);
            return true;
          }
        } catch {}
      }
    }
    return false;
  }

  // Kandidaten im Scope (Buttons, Links, role=button, Klassen, reiner Text)
  const scoped = [
    scope.getByRole("button", { name: /^\s*approve\s*$/i }),
    scope.getByRole("link",   { name: /^\s*approve\s*$/i }),
    scope.locator('input[type="submit"][value*="Approve" i], input[type="button"][value*="Approve" i]'),
    scope.locator('[role="button"]:has-text("Approve")'),
    scope.locator('button:has-text("Approve"), a:has-text("Approve")'),
    scope.locator('*:is(.btn, .button, [class*="btn"], [class*="Button"]):has-text("Approve")'),
    scope.getByText(/^Approve$/i),           // reiner Textknoten
    scope.locator('text=/^\\s*Approve\\s*$/i')
  ];
  if (await clickFirstVisible(scoped)) return true;

  // Globaler Fallback (falls Scope knapp daneben liegt)
  const global = [
    page.getByRole("button", { name: /^\s*approve\s*$/i }),
    page.getByRole("link",   { name: /^\s*approve\s*$/i }),
    page.locator('[role="button"]:has-text("Approve")'),
    page.locator('button:has-text("Approve"), a:has-text("Approve")'),
    page.locator('*:is(.btn, .button, [class*="btn"], [class*="Button"]):has-text("Approve")'),
    page.getByText(/^Approve$/i),
    page.locator('text=/^\\s*Approve\\s*$/i')
  ];
  if (await clickFirstVisible(global)) return true;

  // kleiner Scroll-Scan
  for (const y of [400, 900, 1600]) {
    await page.mouse.wheel(0, y);
    await page.waitForTimeout(180);
    if (await clickFirstVisible([...scoped, ...global])) return true;
  }

  return false;
}

async function approveOne(opts = { fast: true }) {
  if (!inWindow()) return { ok:false, reason:"OUTSIDE_WINDOW" };
  if (approvesToday >= env.MAX_PER_DAY) return { ok:false, reason:"DAILY_LIMIT" };
  if (busy) return { ok:false, reason:"BUSY" };

  busy = true;
  try {
    return await withCtx(async (page) => {
      if (opts.fast) {
        await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(()=>{});
        await dismissOverlays(page).catch(()=>{});
        logHere(page, "fast:afterGoto");

        if (onLoginUrl(page)) {
          return { ok:false, reason:"LOGIN_REQUIRED" };
        }

        const ok = await tryApproveOnDashboard(page);
        if (ok) { approvesToday++; return { ok:true, reason: "APPROVED_FAST" }; }
        return { ok:false, reason:"NO_BUTTON" };
      }

      // ROBUST
      const logged = await ensureOnDashboard(page);
      if (!logged) return { ok:false, reason:"LOGIN_REQUIRED" };

      for (let i = 0; i < 5; i++) {
        const ok = await tryApproveOnDashboard(page);
        if (ok) { approvesToday++; return { ok:true, reason: i===0 ? "APPROVED_DIRECT" : "APPROVED_AFTER_REFRESH" }; }

        const bell = page.getByRole("button", { name: /notifications|bell/i }).first();
        if (await bell.count() > 0) {
          await bell.click().catch(()=>{});
          await page.waitForTimeout(500);
          const ok2 = await tryApproveOnDashboard(page);
          if (ok2) { approvesToday++; return { ok:true, reason:"APPROVED_VIA_BELL" }; }
        }
        await page.reload({ waitUntil: "networkidle" });
      }

      try { await page.screenshot({ path: `no-approve-${Date.now()}.png`, fullPage: true }); } catch {}
      return { ok:false, reason:"NO_BUTTON" };
    });
  } catch (e) {
    console.error("approveOne error:", e);
    return { ok:false, reason:"ERROR", msg: e.message };
  } finally {
    busy = false;
  }
}

// ---------- Heartbeat (randomisiert 7–12 min) ----------
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

let hbTimer = null;
async function heartbeat(){
  if (!inWindow()) return;
  try {
    await withCtx(async (page) => {
      await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(()=>{});
      if (onLoginUrl(page) && env.EMAIL && env.PASSWORD) {
        await ensureOnDashboard(page).catch(()=>{});
      }
      await dismissOverlays(page).catch(()=>{});
    });
    console.log("🔄 Heartbeat OK");
  } catch(e){
    console.error("Heartbeat:", e.message);
  }
}

function scheduleNextHeartbeat() {
  const minMs = env.HEARTBEAT_MIN_MIN * 60_000;
  const maxMs = env.HEARTBEAT_MAX_MIN * 60_000;
  const jitter = randInt(0, 20) * 1000;
  const delay = randInt(minMs, maxMs) + jitter;
  console.log(`⏰ Next heartbeat in ~${(delay/60000).toFixed(1)} min`);
  hbTimer = setTimeout(async () => {
    await heartbeat();
    scheduleNextHeartbeat();
  }, delay);
}

// Reset Daily Counter
cron.schedule("0 0 * * *", () => { approvesToday = 0; }, { timezone: "UTC" });

// ---------- HTTP Server ----------
const app = express();

function checkAuth(req,res,next){
  if (!env.AUTH_TOKEN) return next();
  const token = req.headers["x-auth"] || req.query.auth;
  if (token !== env.AUTH_TOKEN) return res.status(401).json({ ok:false, reason:"UNAUTHORIZED" });
  next();
}

app.get("/approve", checkAuth, async (_req,res)=> res.json(await approveOne({ fast:false })));
app.get("/approve-fast", checkAuth, async (_req,res)=> res.json(await approveOne({ fast:true })));

app.get("/login-status", checkAuth, async (_req,res)=>{
  try{
    const r = await withCtx(async page=>{
      await page.goto(env.DASH_URL, { waitUntil:"domcontentloaded", timeout: env.FAST_LOAD_MS });
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
  hbEveryMin: env.HEARTBEAT_MIN_MIN + "-" + env.HEARTBEAT_MAX_MIN
}));

// ---- Fast webhook ----
app.post("/hook/telegram", checkAuth, express.json({ limit: "64kb" }), async (req, res) => {
  try {
    const msg = (req.body && req.body.message) ? String(req.body.message) : "";
    console.log("Signal received:", msg.slice(0, 160));
  } catch {}
  res.json({ ok: true, queued: true });

  let rFast = null;
  try {
    rFast = await approveOne({ fast: true });
    console.log("approve-async fast:", rFast);
  } catch (e) {
    console.error("approve-async fast error:", e.message);
  }

  if (!rFast || (rFast.ok === false && (rFast.reason === "NO_BUTTON" || rFast.reason === "LOGIN_REQUIRED"))) {
    try {
      const r2 = await approveOne({ fast: false });
      console.log("approve-async fallback:", r2);
    } catch (e) {
      console.error("approve-async fallback error:", e.message);
    }
  }
});

// ---------- Start ----------
app.listen(Number(env.PORT), () => {
  console.log(`Approver Service up on ${env.PORT} | window ${env.WINDOW_START}-${env.WINDOW_END} UTC`);
  scheduleNextHeartbeat();
});
