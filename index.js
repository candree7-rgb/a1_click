// index.js — A1 Approver v3.9.2 - Fix confirm dialog (scope → page)

import express from "express";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- ENV ----------
const env = {
  PORT: process.env.PORT || "8080",
  WINDOW_START: process.env.WINDOW_START || "00:00",
  WINDOW_END: process.env.WINDOW_END || "23:59",
  HEARTBEAT_MIN_MIN: Number(process.env.HEARTBEAT_MIN_MIN || "7"),
  HEARTBEAT_MAX_MIN: Number(process.env.HEARTBEAT_MAX_MIN || "12"),
  MAX_PER_DAY: Number(process.env.MAX_PER_DAY || "999999"),
  FAST_LOAD_MS: Number(process.env.FAST_LOAD_MS || "1500"),
  CLICK_WAIT_MS: Number(process.env.CLICK_WAIT_MS || "1000"),
  POST_CLICK_VERIFY_MS: Number(process.env.POST_CLICK_VERIFY_MS || "3000"),
  DASH_URL: process.env.DASH_URL || "https://app.algosone.ai/dashboard",
  LOGIN_URL: process.env.LOGIN_URL || "https://app.algosone.ai/login",
  LOGIN_METHOD: (process.env.LOGIN_METHOD || "password").toLowerCase(),
  EMAIL: process.env.EMAIL || "",
  PASSWORD: process.env.PASSWORD || "",
  AUTH_TOKEN: process.env.AUTH_TOKEN || "",
  DEBUG_SHOTS: /^true$/i.test(process.env.DEBUG_SHOTS || ""),
  DEBUG_TRACE: /^true$/i.test(process.env.DEBUG_TRACE || ""),
  STRICT_VERIFY: /^true$/i.test(process.env.STRICT_VERIFY || "false"),
  NET_OK_REGEX: process.env.NET_OK_REGEX || "approve|oneclick|confirm|execute",
};

const STORAGE_PATH = "/app/storageState.json";
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const DEBUG_DIR = "/app/debug";
try { if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true }); } catch {}

// ---------- State ----------
let approvesToday = 0;
let busy = false;

const LOG_RING = [];
function logLine(...args){ 
  const s = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "); 
  const line = `[${new Date().toISOString()}] ${s}`; 
  console.log(line); 
  LOG_RING.push(line); 
  if (LOG_RING.length > 5000) LOG_RING.shift(); 
}

// ---------- Helpers ----------
const toMin = (s) => { const [h,m]=s.split(":").map(Number); return h*60+m; };
const inWindow = () => {
  const d = new Date(); 
  const cur = d.getUTCHours()*60 + d.getUTCMinutes();
  return cur >= toMin(env.WINDOW_START) && cur <= toMin(env.WINDOW_END);
};
const onLoginUrl = (page) => /app\.algosone\.ai\/login/i.test(page.url()) || /accounts\.google\.com/i.test(page.url());
const ts = () => new Date().toISOString().split("T")[1].replace("Z","");

// ---------- Browser Context ----------
let browserP = null;
let ctx = null;

async function getCtx() {
  if (!browserP) browserP = chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const browser = await browserP;

  if (!ctx) {
    const options = {
      userAgent: DESKTOP_UA,
      viewport: { width: 1366, height: 820 }
    };
    if (fs.existsSync(STORAGE_PATH)) options.storageState = STORAGE_PATH;
    ctx = await browser.newContext(options);
    if (env.DEBUG_TRACE) await ctx.tracing.start({ screenshots: true, snapshots: true });
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
        await c.click({ timeout: 800 }).catch(()=>{}); 
        await page.waitForTimeout(80);
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

// ---------- LOGIN ----------
async function loginWithPassword(page) {
  logLine("🔐 Password login...");
  
  await page.goto(env.LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  
  await page.waitForTimeout(1500);
  await dismissOverlays(page).catch(()=>{});
  await page.waitForTimeout(800);
  
  const email = page.getByLabel(/email/i)
    .or(page.getByPlaceholder(/email|e-mail/i))
    .or(page.locator('input[type="email"]'))
    .first();
  
  await email.waitFor({ state: "visible", timeout: 20000 }); 
  await email.fill(env.EMAIL);
  logLine("📧 Email filled");
  
  const pass = page.getByLabel(/password|passwort/i)
    .or(page.getByPlaceholder(/password|passwort/i))
    .or(page.locator('input[type="password"]'))
    .first();
  
  await pass.waitFor({ state: "visible", timeout: 20000 });
  await pass.fill(env.PASSWORD);
  logLine("🔑 Password filled");
  
  const submit = page.getByRole("button", { name: /sign in|log in|anmelden|login|continue/i })
    .first()
    .or(page.locator('button[type="submit"]'))
    .first();
  
  await submit.click({ timeout: 20000 }).catch(async ()=>{ 
    await pass.press("Enter"); 
  });
  
  logLine("⏎ Submitted");
  
  await page.waitForLoadState("networkidle", { timeout: 90000 });
  await dismissOverlays(page).catch(()=>{});
  await page.waitForURL(/app\.algosone\.ai\/(dash|dashboard)/i, { timeout: 90000 }).catch(()=>{});
  
  logLine("✅ Login complete");
}

async function loginWithGoogle(page) {
  logLine("🔐 Google login...");
  
  await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await dismissOverlays(page).catch(()=>{});
  await page.getByRole("button", { name: /google|continue with google|sign in with google|weiter mit google/i }).first().click({ timeout: 20000 });
  await page.waitForURL(/accounts\.google\.com/i, { timeout: 90000 });
  await page.getByRole("textbox", { name: /email|phone|e-mail/i }).fill(env.EMAIL);
  await page.getByRole("button", { name: /next|weiter/i }).click();
  await page.getByRole("textbox", { name: /password|passwort/i }).fill(env.PASSWORD);
  await page.getByRole("button", { name: /next|weiter/i }).click();
  await page.waitForURL(/app\.algosone\.ai\/(dash|dashboard)/i, { timeout: 90000 });
  await dismissOverlays(page).catch(()=>{});
  
  logLine("✅ Google login complete");
}

async function ensureOnDashboard(page) {
  await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(()=>{});
  await dismissOverlays(page).catch(()=>{});
  if (!onLoginUrl(page)) return true;

  await page.goto(env.LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(()=>{});
  await dismissOverlays(page).catch(()=>{});
  if (!env.EMAIL || !env.PASSWORD) return false;
  
  try { 
    (env.LOGIN_METHOD === "google") ? await loginWithGoogle(page) : await loginWithPassword(page); 
  } catch { 
    return false; 
  }
  
  await dismissOverlays(page).catch(()=>{});
  return !onLoginUrl(page);
}

// ---------- Approve ----------
function oneClickSection(scope) {
  return scope.locator("section,div,article").filter({ hasText: /1[- ]?click trade|one[- ]?click/i }).first();
}

function allScopes(page) { 
  return [page, ...page.frames()]; 
}

async function findApproveInScope(scope) {
  let btn = scope.locator('#signals button:has-text("Approve")').first();
  if (await btn.count() > 0) return { btn, why: '#signals' };

  btn = scope.locator('.d-flex.text-end button:has-text("Approve")').first();
  if (await btn.count() > 0) return { btn, why: '.d-flex.text-end' };

  const section = oneClickSection(scope);
  const area = (await section.count()) > 0 ? section : scope;

  btn = area.locator('button.btn-white:has-text("Approve")').first();
  if (await btn.count() > 0) return { btn, why: 'btn-white' };

  btn = area.getByRole("button", { name: /^approve$/i }).first();
  if (await btn.count() > 0) return { btn, why: 'role=button' };

  btn = area.locator('button:has-text("Approve")').first();
  if (await btn.count() > 0) return { btn, why: 'button:has-text' };

  const txt = area.getByText(/^Approve\s*$/i).first();
  if (await txt.count() > 0) {
    const maybeBtn = txt.locator('xpath=ancestor::button[1]').first();
    if (await maybeBtn.count() > 0) return { btn: maybeBtn, why: 'text->ancestor' };
    return { btn: txt, why: 'text-only' };
  }

  return { btn: area.locator('button:has-text("Approve")').first(), why: 'last-resort' };
}

async function clickSmart(page, btn) {
  try { await btn.scrollIntoViewIfNeeded(); } catch {}
  try { await btn.click({ timeout: 800 }); return 'dom-click'; } catch {}
  try {
    const el = await btn.elementHandle();
    if (el) { 
      await page.evaluate((node) => node.click(), el); 
      return 'js-click'; 
    }
  } catch {}
  try {
    const box = await btn.boundingBox();
    if (box) { 
      await page.mouse.click(box.x + box.width/2, box.y + box.height/2); 
      return 'mouse-click'; 
    }
  } catch {}
  return null;
}

async function verifyApproved(page, btnBefore) {
  const started = Date.now();
  const okToast = page.getByText(/approved|executed|success|done|trade (approved|executed)/i).first();
  const netRe = new RegExp(env.NET_OK_REGEX, "i");
  let via = null;

  while (Date.now() - started < env.POST_CLICK_VERIFY_MS) {
    try {
      if (await okToast.count()) { via = 'toast'; break; }
    } catch {}

    try {
      const el = await btnBefore.elementHandle();
      if (el) {
        const disabled = await el.getAttribute("disabled");
        if (disabled !== null) { via = 'disabled'; break; }
        const text = (await el.textContent())?.trim() || "";
        if (/^approved|processing|execut/i.test(text)) { via = 'text-change'; break; }
      } else {
        via = 'gone'; break;
      }
    } catch {}

    const resp = await page.waitForResponse(r =>
      netRe.test(r.url()) && r.request().method() !== 'OPTIONS' && r.ok(),
      { timeout: 250 }
    ).catch(()=>null);
    if (resp) { via = 'net-ok'; break; }

    await page.waitForTimeout(100);
  }

  const ok = env.STRICT_VERIFY ? (via === 'net-ok') : !!via;
  return { ok, via: via || 'timeout' };
}

async function tryApproveOnDashboard(page) {
  for (const scope of allScopes(page)) {
    const { btn, why } = await findApproveInScope(scope);
    if (await btn.count() === 0) continue;

    const clickWay = await clickSmart(scope, btn);
    logLine("clicked", { why, clickWay });

    if (!clickWay) continue;

    await maybeConfirm(page);  // ✅ FIXED: scope → page
    await page.waitForTimeout(env.CLICK_WAIT_MS);

    const verdict = await verifyApproved(scope, btn);
    logLine("verify", verdict);

    if (env.DEBUG_SHOTS) {
      const base = path.join(DEBUG_DIR, `after-click-${Date.now()}-${verdict.ok ? 'OK' : 'NO'}`);
      try {
        await page.screenshot({ path: `${base}.png`, fullPage: true });
        fs.writeFileSync(`${base}.html`, await page.content());
      } catch {}
    }

    if (verdict.ok) return true;
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
        logLine(`[${ts()} fast] url=`, page.url());
        if (onLoginUrl(page)) return { ok:false, reason:"LOGIN_REQUIRED" };

        const ok = await tryApproveOnDashboard(page);
        if (ok) { 
          approvesToday++; 
          return { ok:true, reason:"APPROVED_FAST" }; 
        }

        if (env.DEBUG_SHOTS) {
          const base = path.join(DEBUG_DIR, `no-approve-fast-${Date.now()}`);
          try {
            await page.screenshot({ path: `${base}.png`, fullPage: true });
            fs.writeFileSync(`${base}.html`, await page.content());
          } catch {}
        }
        return { ok:false, reason:"NO_BUTTON" };
      }

      const logged = await ensureOnDashboard(page);
      if (!logged) return { ok:false, reason:"LOGIN_REQUIRED" };

      for (let i = 0; i < 5; i++) {
        if (await tryApproveOnDashboard(page)) { 
          approvesToday++; 
          return { ok:true, reason: i===0 ? "APPROVED_DIRECT" : "APPROVED_AFTER_REFRESH" }; 
        }

        const bell = page.getByRole("button", { name: /notifications|bell/i }).first();
        if (await bell.count()) {
          await bell.click().catch(()=>{});
          await page.waitForTimeout(400);
          if (await tryApproveOnDashboard(page)) { 
            approvesToday++; 
            return { ok:true, reason:"APPROVED_VIA_BELL" }; 
          }
        }
        await page.reload({ waitUntil: "networkidle" }).catch(()=>{});
      }

      if (env.DEBUG_SHOTS) {
        const base = path.join(DEBUG_DIR, `no-approve-${Date.now()}`);
        try {
          await page.screenshot({ path: `${base}.png`, fullPage: true });
          fs.writeFileSync(`${base}.html`, await page.content());
        } catch {}
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

// ---------- HEARTBEAT ----------
const rnd = (a,b)=> Math.floor(Math.random()*(b-a+1))+a;

async function heartbeat(){
  if (!inWindow()) return;
  try {
    await withCtx(async (page) => {
      await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(()=>{});
      await dismissOverlays(page).catch(()=>{});
      
      if (onLoginUrl(page)) {
        logLine("🔄 HB: LOGGED OUT detected!");
        if (env.EMAIL && env.PASSWORD) {
          const success = await ensureOnDashboard(page).catch(() => false);
          if (success) {
            logLine("✅ HB: Re-logged in successfully!");
          } else {
            logLine("❌ HB: Re-login FAILED!");
          }
        } else {
          logLine("❌ HB: No credentials for re-login");
        }
      } else {
        logLine(`✅ HB: Still logged in (url: ${page.url()})`);
      }
    });
    logLine("🔄 HB OK");
  } catch(e){ 
    logLine("❌ HB ERR:", e.message); 
  }
}

function scheduleNextHeartbeat() {
  const minMs = env.HEARTBEAT_MIN_MIN * 60_000;
  const maxMs = env.HEARTBEAT_MAX_MIN * 60_000;
  const jitter = rnd(0, 20) * 1000;
  const delay = rnd(minMs, maxMs) + jitter;
  logLine(`⏰ Next HB in ~${(delay/60000).toFixed(1)} min`);
  setTimeout(async () => { 
    await heartbeat(); 
    scheduleNextHeartbeat(); 
  }, delay);
}

cron.schedule("0 0 * * *", () => { 
  approvesToday = 0; 
  logLine("📅 Reset approval counter");
}, { timezone: "UTC" });

// ---------- HTTP ----------
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
      if (onLoginUrl(page)) return (await ensureOnDashboard(page)) ? "OK" : "LOGIN_REQUIRED";
      return "OK";
    });
    res.json({ ok:true, status:r });
  } catch(e){ 
    res.json({ ok:false, error:e.message }); 
  }
});

app.get("/health", (_req,res)=> res.json({
  ok:true,
  window:`${env.WINDOW_START}-${env.WINDOW_END} UTC`,
  hb:`${env.HEARTBEAT_MIN_MIN}-${env.HEARTBEAT_MAX_MIN} min`,
  version: "3.9.2"
}));

app.post("/hook/telegram", checkAuth, express.json({ limit: "64kb" }), async (req, res) => {
  try { 
    const msg = (req.body && req.body.message) ? String(req.body.message) : ""; 
    logLine("📨", msg.slice(0, 160)); 
  } catch {}
  
  res.json({ ok: true, queued: true });

  (async () => {
    let rFast = null;
    try { 
      rFast = await approveOne({ fast: true }); 
      logLine("Fast:", rFast); 
    } catch (e) { 
      logLine("Fast err:", e.message); 
    }
    
    if (!rFast || (rFast.ok === false && (rFast.reason === "NO_BUTTON" || rFast.reason === "LOGIN_REQUIRED"))) {
      try { 
        const r2 = await approveOne({ fast: false }); 
        logLine("Fallback:", r2); 
      } catch (e) { 
        logLine("Fallback err:", e.message); 
      }
    }
  })();
});

// ---------- DEBUG ----------
app.post("/debug/snap", checkAuth, async (_req, res) => {
  try {
    const out = await withCtx(async (page) => {
      const base = path.join(DEBUG_DIR, `snap-${Date.now()}`);
      await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(()=>{});
      await dismissOverlays(page).catch(()=>{});
      await page.screenshot({ path: `${base}.png`, fullPage: true });
      fs.writeFileSync(`${base}.html`, await page.content());
      return path.basename(base);
    });
    res.json({ ok:true, saved: [`${out}.png`, `${out}.html`] });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get("/debug/probe", checkAuth, async (_req, res) => {
  try {
    const out = await withCtx(async (page) => {
      await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(()=>{});
      await dismissOverlays(page).catch(()=>{});
      const data = [];
      for (const fr of allScopes(page)) {
        const url = fr.url ? fr.url() : "frame";
        const counts = {};
        counts.btnWhite = await fr.locator('button.btn-white:has-text("Approve")').count();
        counts.role = await fr.getByRole("button", { name: /^approve$/i }).count();
        counts.textBtn = await fr.locator('button:has-text("Approve")').count();
        counts.exactText = await fr.getByText(/^Approve\s*$/i).count();
        data.push({ frameUrl: url, counts });
      }
      return data;
    });
    res.json({ ok:true, frames: out });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get("/debug/shots", checkAuth, (_req, res) => {
  try {
    const files = fs.readdirSync(DEBUG_DIR)
      .filter(f => f.endsWith(".png") || f.endsWith(".html"))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(DEBUG_DIR, f)).mtimeMs }))
      .sort((a,b) => b.mtime - a.mtime);
    res.json({ ok:true, dir:"/debug", files });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get("/debug/file/:name", checkAuth, (req, res) => {
  try {
    const safe = (req.params.name || "").replace(/[^a-zA-Z0-9._-]/g, "");
    const full = path.join(DEBUG_DIR, safe);
    if (!full.startsWith(DEBUG_DIR)) return res.status(400).json({ ok:false, error:"Bad path" });
    if (!fs.existsSync(full)) return res.status(404).json({ ok:false, error:"Not found" });
    res.sendFile(full);
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get("/debug/logs", checkAuth, (_req, res) => {
  res.json({ ok:true, lines: LOG_RING.slice(-300) });
});

// ---------- START ----------
app.listen(Number(env.PORT), () => {
  logLine(`🚀 A1 Approver v3.9.2 :${env.PORT}`);
  logLine(`⏰ Window: ${env.WINDOW_START}-${env.WINDOW_END} UTC`);
  logLine(`💓 Heartbeat: ${env.HEARTBEAT_MIN_MIN}-${env.HEARTBEAT_MAX_MIN}min`);
  logLine(`✅ Fix: Confirm dialog (scope → page)`);
  
  (async () => {
    logLine("🔄 Initial heartbeat...");
    await heartbeat();
    scheduleNextHeartbeat();
  })();
});
