// index.js — ULTRA-FAST A1 Approver: Maximum Speed + Reliable Login

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
  HEARTBEAT_MIN_MIN: Number(process.env.HEARTBEAT_MIN_MIN || "5"),
  HEARTBEAT_MAX_MIN: Number(process.env.HEARTBEAT_MAX_MIN || "8"),
  MAX_PER_DAY: Number(process.env.MAX_PER_DAY || "999999"),
  MAX_AGE_SEC: Number(process.env.MAX_AGE_SEC || "10"),
  FAST_LOAD_MS: Number(process.env.FAST_LOAD_MS || "1200"),
  POST_CLICK_VERIFY_MS: Number(process.env.POST_CLICK_VERIFY_MS || "2500"),
  DASH_URL: process.env.DASH_URL || "https://app.algosone.ai/dashboard",
  LOGIN_URL: process.env.LOGIN_URL || "https://app.algosone.ai/login",
  LOGIN_METHOD: (process.env.LOGIN_METHOD || "password").toLowerCase(),
  EMAIL: process.env.EMAIL || "",
  PASSWORD: process.env.PASSWORD || "",
  AUTH_TOKEN: process.env.AUTH_TOKEN || "",
  DEBUG_SHOTS: /^true$/i.test(process.env.DEBUG_SHOTS || ""),
  DEBUG_TRACE: /^true$/i.test(process.env.DEBUG_TRACE || ""),
  STRICT_VERIFY: /^true$/i.test(process.env.STRICT_VERIFY || "false"),
  NET_OK_REGEX: process.env.NET_OK_REGEX || "approve|oneclick|confirm|execute|trade",
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
const ts = () => new Date().toISOString().split("T")[1].replace("Z","");

// ✅ NEW: Content-based logout detection
async function isLoggedOut(page) {
  // Fast check: URL
  const url = page.url();
  if (/\/login/i.test(url) || /accounts\.google\.com/i.test(url)) {
    return true;
  }
  
  // Safe check: Content (AlgosOne shows login without URL change)
  try {
    const hasLoginForm = await page.locator('text="Hello again"').count() > 0;
    return hasLoginForm;
  } catch {
    return false;
  }
}

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

// ---------- ULTRA-FAST OVERLAY KILLER ----------
async function dismissOverlays(page) {
  const started = Date.now();
  
  // PARALLEL: All layers at once
  await Promise.allSettled([
    // Cookie Policy Dialog
    (async () => {
      const hasCookiePolicy = await page.locator('text="COOKIE POLICY"').count() > 0;
      if (hasCookiePolicy) {
        logLine("🍪 Cookie Policy");
        await page.getByRole("button", { name: /back/i }).first().click({ timeout: 500 }).catch(() => {});
        await page.keyboard.press("Escape").catch(() => {});
        await page.evaluate(() => {
          document.querySelectorAll('[role="dialog"], .modal').forEach(d => {
            if (d.textContent?.includes('COOKIE POLICY')) d.remove();
          });
        }).catch(() => {});
      }
    })(),
    
    // Cookie Banner
    (async () => {
      const banner = page.locator('text=/cookies/i')
        .locator('..')
        .locator('button:has-text("Accept"), button:has-text("Agree")')
        .first();
      if (await banner.count() > 0) {
        await banner.click({ timeout: 500 }).catch(() => {});
        await page.context().storageState({ path: STORAGE_PATH }).catch(() => {});
      }
    })(),
    
    // Nuclear: High z-index elements
    page.evaluate(() => {
      let count = 0;
      document.querySelectorAll('*').forEach(el => {
        const style = window.getComputedStyle(el);
        const z = parseInt(style.zIndex);
        if (!isNaN(z) && z > 500 && (style.position === 'fixed' || style.position === 'absolute')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > window.innerWidth * 0.5 || rect.height > window.innerHeight * 0.5) {
            el.remove();
            count++;
          }
        }
      });
      return count;
    }).then(count => { if (count > 0) logLine(`🗑️ Removed ${count} overlays`); }).catch(() => {})
  ]);
  
  const elapsed = Date.now() - started;
  if (elapsed > 100) logLine(`⚡ Overlays: ${elapsed}ms`);
}

// ---------- ULTRA-FAST POPUP HANDLER ----------
async function handlePopupApprove(page, maxWait = 400) {
  const started = Date.now();
  
  try {
    // DIRECT: Find blue button (skip text search)
    const blueBtn = page.locator('[role="dialog"] button, dialog button')
      .filter({ hasText: /^approve$/i })
      .first();
    
    // Wait for button (max 400ms)
    await blueBtn.waitFor({ state: 'visible', timeout: maxWait });
    
    const elapsed = Date.now() - started;
    logLine(`🔵 Popup appeared (${elapsed}ms)`);
    
    // INSTANT CLICK: No extra waits
    const box = await blueBtn.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      logLine("✅ Blue clicked!");
      return true;
    }
    
    await blueBtn.click({ timeout: 300 });
    logLine("✅ Blue clicked!");
    return true;
  } catch {
    // No popup = direct approve (normal flow)
    return false;
  }
}

// ---------- Login ----------
async function loginWithPassword(page) {
  await page.goto(env.LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await dismissOverlays(page);
  
  const email = page.locator('input[type="email"]').first();
  const pass = page.locator('input[type="password"]').first();
  
  await email.waitFor({ state: "visible", timeout: 20000 }); 
  await email.fill(env.EMAIL);
  await pass.fill(env.PASSWORD);
  await pass.press("Enter");
  
  await page.waitForLoadState("networkidle", { timeout: 90000 });
  await dismissOverlays(page);
  await page.waitForURL(/dashboard/i, { timeout: 90000 }).catch(() => {});
}

async function loginWithGoogle(page) {
  await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await dismissOverlays(page);
  await page.getByRole("button", { name: /google/i }).first().click({ timeout: 20000 });
  await page.waitForURL(/accounts\.google\.com/i, { timeout: 90000 });
  await page.getByRole("textbox", { name: /email/i }).fill(env.EMAIL);
  await page.getByRole("button", { name: /next/i }).click();
  await page.getByRole("textbox", { name: /password/i }).fill(env.PASSWORD);
  await page.getByRole("button", { name: /next/i }).click();
  await page.waitForURL(/dashboard/i, { timeout: 90000 });
  await dismissOverlays(page);
}

async function ensureOnDashboard(page) {
  await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(() => {});
  await dismissOverlays(page);
  
  // ✅ USE NEW CHECK
  if (!(await isLoggedOut(page))) return true;

  if (!env.EMAIL || !env.PASSWORD) return false;
  
  try { 
    (env.LOGIN_METHOD === "google") ? await loginWithGoogle(page) : await loginWithPassword(page); 
  } catch { 
    return false; 
  }
  
  await dismissOverlays(page);
  return !(await isLoggedOut(page));
}

// ---------- ULTRA-FAST APPROVE ----------
function allScopes(page) { return [page, ...page.frames()]; }

async function findApproveTargets(scope) {
  const targets = [];
  
  // PRIORITY ORDER: Most specific first
  const selectors = [
    { sel: scope.locator('#signals button.btn-white').filter({ hasText: /^approve$/i }), why: '#signals' },
    { sel: scope.locator('.rounded-box-5 button.btn-white').filter({ hasText: /^approve$/i }), why: 'rounded-box' },
    { sel: scope.locator('button.btn-white').filter({ hasText: /^approve$/i }), why: 'btn-white' },
    { sel: scope.getByRole("button", { name: /^approve$/i }), why: 'role' },
  ];
  
  for (const { sel, why } of selectors) {
    const count = await sel.count();
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        targets.push({ locator: sel.nth(i), why: `${why}[${i}]` });
      }
    }
  }
  
  return targets;
}

async function clickRobust(page, locator) {
  // FAST: Skip scroll (already visible from screenshots)
  let box = await locator.boundingBox().catch(() => null);
  
  if (!box) {
    const el = await locator.elementHandle().catch(() => null);
    if (el) {
      box = await page.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }, el).catch(() => null);
    }
  }
  
  // PRIO 1: MOUSE (fastest, ignores overlays)
  if (box?.width > 0 && box?.height > 0) {
    try {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      
      // Hide overlays BEFORE click
      await page.evaluate(() => {
        document.querySelectorAll('*').forEach(el => {
          const z = parseInt(window.getComputedStyle(el).zIndex);
          if (!isNaN(z) && z > 900) el.style.display = 'none';
        });
      }).catch(() => {});
      
      await page.mouse.click(x, y);
      logLine(`✓ Click @${Math.round(x)},${Math.round(y)}`);
      return true;
    } catch {}
  }
  
  // PRIO 2: Force click
  try {
    await locator.click({ timeout: 1000, force: true });
    logLine("✓ Force click");
    return true;
  } catch {}
  
  // PRIO 3: JS dispatch
  try {
    const el = await locator.elementHandle();
    if (el) {
      await page.evaluate(node => {
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        node.click();
      }, el);
      logLine("✓ JS click");
      return true;
    }
  } catch {}
  
  return false;
}

async function verifyApproved(page, targetBefore) {
  const started = Date.now();
  const netRe = new RegExp(env.NET_OK_REGEX, "i");
  let via = null;

  while (Date.now() - started < env.POST_CLICK_VERIFY_MS) {
    // FAST CHECKS: Parallel
    const [toastFound, buttonGone, networkOk] = await Promise.all([
      // Toast
      page.locator('text=/approved|executed|success|confirmed/i').first().count()
        .then(c => c > 0),
      
      // Button state
      targetBefore.count().then(c => c === 0),
      
      // Network
      page.waitForResponse(r => {
        const url = r.url();
        const match = netRe.test(url) && r.request().method() !== 'OPTIONS';
        return match && r.ok();
      }, { timeout: 150 }).then(() => true).catch(() => false)
    ]);
    
    if (toastFound) {
      via = 'toast';
      break;
    }
    if (buttonGone) {
      via = 'removed';
      break;
    }
    if (networkOk) {
      via = 'net';
      break;
    }
    
    await page.waitForTimeout(100);
  }

  const elapsed = Date.now() - started;
  const ok = env.STRICT_VERIFY ? (via === 'net') : !!via;
  logLine(`${ok ? '✅' : '❌'} Verify: ${via || 'timeout'} (${elapsed}ms)`);
  
  return { ok, via: via || 'timeout' };
}

async function tryApproveOnDashboard(page) {
  const overall = Date.now();
  
  // FAST: Minimal waits
  await page.waitForTimeout(150);
  await dismissOverlays(page);
  await page.waitForTimeout(100);

  for (const scope of allScopes(page)) {
    const targets = await findApproveTargets(scope);
    logLine(`Found ${targets.length} targets`);
    
    if (targets.length === 0) continue;

    for (const target of targets) {
      const { locator, why } = target;
      logLine(`🎯 ${why}`);
      
      // SKIP visibility check (trust findApproveTargets)
      const clicked = await clickRobust(scope, locator);
      if (!clicked) {
        logLine("   ❌ Click failed");
        continue;
      }

      // ULTRA-FAST: Parallel popup check + verify
      const popupPromise = handlePopupApprove(page, 400);
      
      // Wait for popup (max 400ms)
      const hasPopup = await popupPromise;
      
      // SMART WAIT: Only if needed
      if (hasPopup) {
        await page.waitForTimeout(300); // Wait for trade execution
      } else {
        await page.waitForTimeout(500); // Direct approve
      }

      const verdict = await verifyApproved(scope, locator);

      if (env.DEBUG_SHOTS) {
        const base = path.join(DEBUG_DIR, `click-${Date.now()}-${verdict.ok ? 'OK' : 'FAIL'}`);
        await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
        fs.writeFileSync(`${base}.html`, await page.content()).catch(() => {});
      }

      if (verdict.ok) {
        const total = Date.now() - overall;
        logLine(`⚡ Total: ${total}ms`);
        return true;
      }
      
      logLine(`   ⚠ Failed: ${verdict.via}`);
    }
  }
  
  return false;
}

async function approveOne(opts = { fast: true, signalTime: null }) {
  const execStart = Date.now();
  
  if (opts.signalTime) {
    const ageSec = Math.round((Date.now() - opts.signalTime) / 1000);
    if (ageSec > env.MAX_AGE_SEC) {
      logLine(`⏰ Too old: ${ageSec}s`);
      return { ok: false, reason: "TOO_OLD", ageSec };
    }
    logLine(`⏱️ Age: ${ageSec}s`);
  }
  
  if (!inWindow()) return { ok: false, reason: "OUTSIDE_WINDOW" };
  if (approvesToday >= env.MAX_PER_DAY) return { ok: false, reason: "LIMIT" };
  if (busy) return { ok: false, reason: "BUSY" };

  busy = true;
  try {
    return await withCtx(async (page) => {
      if (opts.fast) {
        await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS });
        await dismissOverlays(page);
        logLine(`[${ts()}] ${page.url()}`);
        
        // ✅ USE NEW CHECK (fast URL check only, no content)
        if (/\/login/i.test(page.url())) {
          logLine("⚠️ On login page - skip");
          return { ok: false, reason: "LOGGED_OUT" };
        }

        // GUARANTEED REFRESH (button appears after)
        await page.reload({ waitUntil: "domcontentloaded", timeout: 2500 });
        await dismissOverlays(page);
        await page.waitForTimeout(150);

        if (await tryApproveOnDashboard(page)) {
          approvesToday++;
          const total = Date.now() - execStart;
          logLine(`🚀 APPROVED in ${total}ms`);
          return { ok: true, reason: "FAST", ms: total };
        }

        if (env.DEBUG_SHOTS) {
          const base = path.join(DEBUG_DIR, `no-btn-${Date.now()}`);
          await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
        }
        return { ok: false, reason: "NO_BUTTON" };
      }

      // SLOW
      const logged = await ensureOnDashboard(page);
      if (!logged) return { ok: false, reason: "LOGIN_REQ" };

      for (let i = 0; i < 5; i++) {
        if (await tryApproveOnDashboard(page)) { 
          approvesToday++; 
          const total = Date.now() - execStart;
          logLine(`🚀 APPROVED in ${total}ms`);
          return { ok: true, reason: i === 0 ? "DIRECT" : "REFRESH", ms: total }; 
        }

        if (i < 4) {
          logLine(`Retry ${i + 2}/5`);
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          await page.waitForTimeout(300);
        }
      }

      return { ok: false, reason: "NO_BUTTON" };
    });
  } catch (e) {
    console.error("approveOne error:", e);
    return { ok: false, reason: "ERROR", msg: e.message };
  } finally {
    busy = false;
  }
}

// ---------- Heartbeat ----------
const rnd = (a,b) => Math.floor(Math.random() * (b - a + 1)) + a;

async function heartbeat(){
  if (!inWindow()) return;
  try {
    await withCtx(async (page) => {
      await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(() => {});
      
      // ✅ BETTER CHECK: URL + Content
      const url = page.url();
      const isLoginUrl = /\/login/i.test(url) || /accounts\.google\.com/i.test(url);
      const hasLoginForm = await page.locator('text="Hello again"').count() > 0;
      
      if (isLoginUrl || hasLoginForm) {
        logLine(`🔄 HB: Logged out (url=${isLoginUrl}, form=${hasLoginForm})`);
        if (env.EMAIL && env.PASSWORD) {
          await ensureOnDashboard(page);
          logLine("✅ HB: Re-logged in");
        } else {
          logLine("❌ HB: No credentials");
        }
      } else {
        logLine("✅ HB: Still logged in");
      }
    });
    logLine("🔄 HB OK");
  } catch(e){ 
    logLine("HB ERR:", e.message); 
  }
}

function scheduleNextHeartbeat() {
  const delay = rnd(env.HEARTBEAT_MIN_MIN * 60000, env.HEARTBEAT_MAX_MIN * 60000) + rnd(0, 20000);
  logLine(`⏰ Next HB: ~${(delay / 60000).toFixed(1)}min`);
  setTimeout(async () => { 
    await heartbeat(); 
    scheduleNextHeartbeat(); 
  }, delay);
}

cron.schedule("0 0 * * *", () => { 
  approvesToday = 0; 
  logLine("📅 Reset"); 
}, { timezone: "UTC" });

// ---------- HTTP ----------
const app = express();

function checkAuth(req, res, next){
  if (!env.AUTH_TOKEN) return next();
  const token = req.headers["x-auth"] || req.query.auth;
  if (token !== env.AUTH_TOKEN) return res.status(401).json({ ok: false, reason: "UNAUTH" });
  next();
}

app.get("/approve", checkAuth, async (_req, res) => res.json(await approveOne({ fast: false, signalTime: Date.now() })));
app.get("/approve-fast", checkAuth, async (_req, res) => res.json(await approveOne({ fast: true, signalTime: Date.now() })));

app.get("/login-status", checkAuth, async (_req, res) => {
  try {
    const r = await withCtx(async page => {
      await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS });
      const loggedOut = await isLoggedOut(page);
      if (loggedOut) return (await ensureOnDashboard(page)) ? "OK" : "FAIL";
      return "OK";
    });
    res.json({ ok: true, status: r });
  } catch(e) { 
    res.json({ ok: false, error: e.message }); 
  }
});

app.get("/health", (_req, res) => res.json({
  ok: true,
  window: `${env.WINDOW_START}-${env.WINDOW_END}`,
  hb: `${env.HEARTBEAT_MIN_MIN}-${env.HEARTBEAT_MAX_MIN}min`,
  maxAge: env.MAX_AGE_SEC,
  today: approvesToday
}));

app.post("/hook/telegram", checkAuth, express.json({ limit: "64kb" }), async (req, res) => {
  const signalTime = Date.now();
  
  try { 
    const msg = req.body?.message ? String(req.body.message) : ""; 
    logLine("📨", msg.slice(0, 80)); 
  } catch {}
  
  res.json({ ok: true, queued: true });

  (async () => {
    let rFast = null;
    try { 
      rFast = await approveOne({ fast: true, signalTime }); 
      logLine("Fast:", rFast); 
    } catch (e) { 
      logLine("Fast err:", e.message); 
    }
    
    if (rFast?.reason === "TOO_OLD") return;
    
    if (!rFast || (rFast.ok === false && (rFast.reason === "NO_BUTTON" || rFast.reason === "LOGGED_OUT"))) {
      const ageSec = Math.round((Date.now() - signalTime) / 1000);
      if (ageSec > env.MAX_AGE_SEC) {
        logLine(`⏰ Skip fallback (${ageSec}s)`);
        return;
      }
      
      try { 
        const r2 = await approveOne({ fast: false, signalTime }); 
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
      await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(() => {});
      await dismissOverlays(page);
      await page.screenshot({ path: `${base}.png`, fullPage: true });
      fs.writeFileSync(`${base}.html`, await page.content());
      return path.basename(base);
    });
    res.json({ ok: true, saved: [`${out}.png`, `${out}.html`] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/debug/probe", checkAuth, async (_req, res) => {
  try {
    const out = await withCtx(async (page) => {
      await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(() => {});
      await dismissOverlays(page);
      const data = [];
      for (const fr of allScopes(page)) {
        const counts = {
          signals: await fr.locator('#signals button.btn-white').filter({ hasText: /approve/i }).count(),
          roundedBox: await fr.locator('.rounded-box-5 button.btn-white').filter({ hasText: /approve/i }).count(),
          btnWhite: await fr.locator('button.btn-white').filter({ hasText: /approve/i }).count(),
          role: await fr.getByRole("button", { name: /^approve$/i }).count(),
        };
        data.push({ frameUrl: fr.url ? fr.url() : "main", counts });
      }
      return data;
    });
    res.json({ ok: true, frames: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/debug/shots", checkAuth, (_req, res) => {
  try {
    const files = fs.readdirSync(DEBUG_DIR)
      .filter(f => f.endsWith(".png") || f.endsWith(".html"))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(DEBUG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 50);
    res.json({ ok: true, files });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/debug/file/:name", checkAuth, (req, res) => {
  try {
    const safe = (req.params.name || "").replace(/[^a-zA-Z0-9._-]/g, "");
    const full = path.join(DEBUG_DIR, safe);
    if (!full.startsWith(DEBUG_DIR)) return res.status(400).json({ ok: false });
    if (!fs.existsSync(full)) return res.status(404).json({ ok: false });
    res.sendFile(full);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/debug/logs", checkAuth, (_req, res) => {
  res.json({ ok: true, lines: LOG_RING.slice(-300) });
});

// ---------- Start ----------
app.listen(Number(env.PORT), () => {
  logLine(`🚀 Ultra-Fast Approver v3.1 :${env.PORT}`);
  logLine(`⏰ ${env.WINDOW_START}-${env.WINDOW_END}`);
  logLine(`💓 ${env.HEARTBEAT_MIN_MIN}-${env.HEARTBEAT_MAX_MIN}min`);
  logLine(`⏱️ Max age: ${env.MAX_AGE_SEC}s`);
  logLine(`⚡ Target: <4s signal→execution`);
  logLine(`✅ Content-based login detection enabled`);
  scheduleNextHeartbeat();
});
