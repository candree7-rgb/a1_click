// index.js — A1 Approver (Playwright) + GUARANTEED REFRESH + MAX_AGE + BULLETPROOF CLICK + NUCLEAR OVERLAY KILLER

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

  // Betriebsfenster (UTC)
  WINDOW_START: process.env.WINDOW_START || "00:00",
  WINDOW_END: process.env.WINDOW_END || "23:59",

  // Random Heartbeat
  HEARTBEAT_MIN_MIN: Number(process.env.HEARTBEAT_MIN_MIN || "5"),
  HEARTBEAT_MAX_MIN: Number(process.env.HEARTBEAT_MAX_MIN || "8"),

  // Limits / Tuning
  MAX_PER_DAY: Number(process.env.MAX_PER_DAY || "999999"),
  MAX_AGE_SEC: Number(process.env.MAX_AGE_SEC || "10"),
  FAST_LOAD_MS: Number(process.env.FAST_LOAD_MS || "1200"),
  CLICK_WAIT_MS: Number(process.env.CLICK_WAIT_MS || "1000"),
  POST_CLICK_VERIFY_MS: Number(process.env.POST_CLICK_VERIFY_MS || "3000"),

  // AlgosOne
  DASH_URL: process.env.DASH_URL || "https://app.algosone.ai/dashboard",
  LOGIN_URL: process.env.LOGIN_URL || "https://app.algosone.ai/login",
  LOGIN_METHOD: (process.env.LOGIN_METHOD || "password").toLowerCase(),
  EMAIL: process.env.EMAIL || "",
  PASSWORD: process.env.PASSWORD || "",

  // HTTP-Auth
  AUTH_TOKEN: process.env.AUTH_TOKEN || "",

  // Debug
  DEBUG_SHOTS: /^true$/i.test(process.env.DEBUG_SHOTS || ""),
  DEBUG_TRACE: /^true$/i.test(process.env.DEBUG_TRACE || ""),
  STRICT_VERIFY: /^true$/i.test(process.env.STRICT_VERIFY || "false"),
  NET_OK_REGEX: process.env.NET_OK_REGEX || "approve|oneclick|confirm|execute|trade",
};

const STORAGE_PATH = "/app/storageState.json";
const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const DEBUG_DIR = "/app/debug";
try { if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true }); } catch {}

// ---------- State ----------
let approvesToday = 0;
let busy = false;

// in-memory log tail
const LOG_RING = [];
function logLine(...args){ const s = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "); const line = `[${new Date().toISOString()}] ${s}`; console.log(line); LOG_RING.push(line); if (LOG_RING.length > 5000) LOG_RING.shift(); }

// ---------- Helpers ----------
const toMin = (s) => { const [h,m]=s.split(":").map(Number); return h*60+m; };
const inWindow = () => {
  const d = new Date(); const cur = d.getUTCHours()*60 + d.getUTCMinutes();
  return cur >= toMin(env.WINDOW_START) && cur <= toMin(env.WINDOW_END);
};
const onLoginUrl = (page) => /app\.algosone\.ai\/login/i.test(page.url()) || /accounts\.google\.com/i.test(page.url());
const ts = () => new Date().toISOString().split("T")[1].replace("Z","");

// ---------- Singleton Browser / Context ----------
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

// ---------- NUCLEAR OVERLAY KILLER ----------
async function dismissOverlays(page) {
  // LAYER 0: AlgosOne Cookie Policy (der aus dem Screenshot!)
  try {
    const hasCookiePolicy = await page.locator('text="COOKIE POLICY"').count() > 0;
    if (hasCookiePolicy) {
      logLine("🍪 Cookie Policy detected! KILLING...");
      
      // 1. Back Button
      const backBtn = page.getByRole("button", { name: /back/i }).first();
      if (await backBtn.count() > 0) {
        await backBtn.click({ timeout: 800 }).catch(() => {});
        logLine("✓ Clicked Back button");
      }
      
      // 2. Escape
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(100);
      
      // 3. Nuclear: Remove via JS
      await page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"], .modal, [class*="modal"], [class*="dialog"]');
        dialogs.forEach(d => {
          if (d.textContent && d.textContent.includes('COOKIE POLICY')) {
            d.remove();
          }
        });
      }).catch(() => {});
      
      await page.waitForTimeout(200);
      logLine("✓ Cookie Policy killed");
    }
  } catch (e) {
    logLine("Cookie Policy kill error:", e.message.slice(0, 60));
  }

  // LAYER 1: Standard Cookie Banners
  const standardCookies = [
    page.getByRole("button", { name: /accept all|accept|agree|got it|okay|ok|verstanden|zustimmen/i }).first(),
    page.locator('button:has-text("Accept")').first(),
    page.locator('button:has-text("I Agree")').first(),
  ];
  
  for (const btn of standardCookies) {
    try {
      if (await btn.count() > 0) {
        await btn.click({ timeout: 800 }).catch(() => {});
        await page.waitForTimeout(100);
      }
    } catch {}
  }

  // LAYER 2: Generic Dialogs
  try {
    const dialogs = await page.locator('[role="dialog"], .modal, .popup').all();
    
    for (const dialog of dialogs) {
      try {
        const isVisible = await dialog.isVisible().catch(() => false);
        if (!isVisible) continue;
        
        // Try close button
        const closeBtn = dialog.locator('button:has-text("×"), button:has-text("Close"), [aria-label="Close"]').first();
        if (await closeBtn.count() > 0) {
          await closeBtn.click({ timeout: 500 }).catch(() => {});
        } else {
          // Nuclear: Remove dialog
          await dialog.evaluate(el => el.remove()).catch(() => {});
        }
      } catch {}
    }
  } catch {}

  // LAYER 3: NUCLEAR - Remove ALL high z-index overlays
  try {
    const removed = await page.evaluate(() => {
      let count = 0;
      
      // Find all elements with high z-index
      const allElements = Array.from(document.querySelectorAll('*'));
      const highZIndexElements = allElements.filter(el => {
        const style = window.getComputedStyle(el);
        const z = parseInt(style.zIndex);
        const pos = style.position;
        
        // High z-index + positioned = likely overlay
        return !isNaN(z) && z > 500 && (pos === 'fixed' || pos === 'absolute');
      });
      
      highZIndexElements.forEach(el => {
        // Check if it's covering significant viewport
        const rect = el.getBoundingClientRect();
        const coversScreen = rect.width > window.innerWidth * 0.5 || rect.height > window.innerHeight * 0.5;
        
        if (coversScreen) {
          el.remove();
          count++;
        }
      });
      
      // Also remove backdrop elements
      const backdrops = document.querySelectorAll('.backdrop, .overlay, [class*="backdrop"], [class*="overlay"]');
      backdrops.forEach(b => {
        const style = window.getComputedStyle(b);
        if (parseInt(style.zIndex) > 100) {
          b.remove();
          count++;
        }
      });
      
      return count;
    }).catch(() => 0);
    
    if (removed > 0) {
      logLine(`🗑️ Nuclear removal: ${removed} overlay elements`);
    }
  } catch (e) {
    logLine("Nuclear overlay removal error:", e.message.slice(0, 60));
  }
}

async function maybeConfirm(page) {
  const dlg = page.getByRole("dialog");
  if (await dlg.count() === 0) return;
  const btn = dlg.getByRole("button", { name: /^(confirm|yes|ok|continue)$/i }).first();
  if (await btn.count() > 0) { await btn.click().catch(()=>{}); await page.waitForTimeout(150); }
}

// ---------- Login ----------
async function loginWithPassword(page) {
  await page.goto(env.LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await dismissOverlays(page).catch(()=>{});
  const email = page.getByLabel(/email/i).or(page.getByPlaceholder(/email|e-mail/i)).or(page.locator('input[type="email"]')).first();
  const pass  = page.getByLabel(/password|passwort/i).or(page.getByPlaceholder(/password|passwort/i)).or(page.locator('input[type="password"]')).first();
  await email.waitFor({ state: "visible", timeout: 20000 }); await email.fill(env.EMAIL);
  await pass.waitFor({ state: "visible", timeout: 20000 });  await pass.fill(env.PASSWORD);
  const submit = page.getByRole("button", { name: /sign in|log in|anmelden|login|continue/i }).first()
    .or(page.locator('button[type="submit"]')).first();
  await submit.click({ timeout: 20000 }).catch(async ()=>{ await pass.press("Enter"); });
  await page.waitForLoadState("networkidle", { timeout: 90000 });
  await dismissOverlays(page).catch(()=>{});
  await page.waitForURL(/app\.algosone\.ai\/(dash|dashboard)/i, { timeout: 90000 }).catch(()=>{});
}

async function loginWithGoogle(page) {
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
}

async function ensureOnDashboard(page) {
  await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(()=>{});
  await dismissOverlays(page).catch(()=>{});
  if (!onLoginUrl(page)) return true;

  await page.goto(env.LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(()=>{});
  await dismissOverlays(page).catch(()=>{});
  if (!env.EMAIL || !env.PASSWORD) return false;
  try { (env.LOGIN_METHOD === "google") ? await loginWithGoogle(page) : await loginWithPassword(page); }
  catch { return false; }
  await dismissOverlays(page).catch(()=>{});
  return !onLoginUrl(page);
}

// ---------- Approve ----------
function allScopes(page) { return [page, ...page.frames()]; }

async function findApproveTargets(scope) {
  const targets = [];
  
  // LAYER 1: Präzise Button-Selektoren
  const selectors = [
    { sel: scope.locator('.rounded-box-5 button.btn-white').filter({ hasText: /^approve$/i }), why: 'rounded-box + btn-white' },
    { sel: scope.locator('#signals .d-flex.text-end button.btn-white').filter({ hasText: /^approve$/i }), why: '#signals path' },
    { sel: scope.locator('button.btn-white').filter({ hasText: /^approve$/i }), why: 'btn-white' },
  ];
  
  const section = scope.locator("section,div,article").filter({ hasText: /1[- ]?click trade/i }).first();
  if (await section.count() > 0) {
    selectors.push({ sel: section.locator('button').filter({ hasText: /^approve$/i }), why: '1-click-section button' });
  }
  
  selectors.push(
    { sel: scope.getByRole("button", { name: /^approve$/i }), why: 'role=button' },
    { sel: scope.locator('button:has-text("Approve")'), why: 'button:has-text' }
  );
  
  for (const { sel, why } of selectors) {
    const count = await sel.count();
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        targets.push({ locator: sel.nth(i), why: `${why}[${i}]`, type: 'button' });
      }
    }
  }
  
  // LAYER 2: Text-Node Fallback
  const textNodes = await scope.getByText(/^Approve\s*$/i).all();
  for (let i = 0; i < textNodes.length; i++) {
    targets.push({ locator: textNodes[i], why: `text-node[${i}]`, type: 'text' });
  }
  
  return targets;
}

async function clickRobust(page, locator, type) {
  try { 
    await locator.scrollIntoViewIfNeeded({ timeout: 1000 }); 
  } catch {}
  
  await page.waitForTimeout(200);
  
  let box = null;
  try {
    box = await locator.boundingBox();
  } catch {}
  
  if (!box) {
    const el = await locator.elementHandle().catch(() => null);
    if (el) {
      box = await page.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }, el).catch(() => null);
    }
  }
  
  // PRIO 1: MOUSE CLICK (ignores ALL overlays)
  if (box && box.width > 0 && box.height > 0) {
    try {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      
      logLine(`🖱️ Mouse click at ${Math.round(x)},${Math.round(y)}`);
      
      // FORCE: Hide ALL overlays right before click
      await page.evaluate(() => {
        const highZ = Array.from(document.querySelectorAll('*')).filter(el => {
          const z = parseInt(window.getComputedStyle(el).zIndex);
          return !isNaN(z) && z > 900; // Very high z-index
        });
        highZ.forEach(el => el.style.display = 'none');
      }).catch(() => {});
      
      await page.mouse.move(x, y);
      await page.waitForTimeout(80);
      await page.mouse.down();
      await page.waitForTimeout(60);
      await page.mouse.up();
      await page.waitForTimeout(150);
      
      logLine("✓ mouse-click (overlays hidden)");
      return 'mouse-click';
    } catch (e) {
      logLine("⚠ mouse-click failed:", e.message.slice(0, 80));
    }
  }
  
  // PRIO 2: Force Click
  try { 
    await locator.click({ timeout: 1500, force: true, delay: 80 }); 
    await page.waitForTimeout(150);
    logLine("✓ force-click");
    return 'force-click'; 
  } catch (e) {
    logLine("⚠ force-click failed:", e.message.slice(0, 80));
  }
  
  // PRIO 3: JS Event Dispatch
  try {
    const el = await locator.elementHandle();
    if (el) { 
      await page.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        
        ['mousedown', 'mouseup', 'click'].forEach(type => {
          const evt = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y
          });
          node.dispatchEvent(evt);
        });
        
        node.click();
      }, el);
      await page.waitForTimeout(150);
      logLine("✓ js-events");
      return 'js-events'; 
    }
  } catch (e) {
    logLine("⚠ js-events failed:", e.message.slice(0, 80));
  }
  
  // PRIO 4: Normal Click
  try { 
    await locator.click({ timeout: 1000, delay: 80 }); 
    await page.waitForTimeout(150);
    logLine("✓ normal-click");
    return 'normal-click'; 
  } catch (e) {
    logLine("⚠ normal-click failed:", e.message.slice(0, 80));
  }
  
  // PRIO 5: Doppelklick
  try { 
    await locator.dblclick({ timeout: 1000, force: true, delay: 80 }); 
    await page.waitForTimeout(150);
    logLine("✓ dbl-click");
    return 'dbl-click'; 
  } catch (e) {
    logLine("⚠ dbl-click failed:", e.message.slice(0, 80));
  }
  
  return null;
}

async function verifyApproved(page, targetBefore) {
  const started = Date.now();
  const netRe = new RegExp(env.NET_OK_REGEX, "i");
  let via = null;

  while (Date.now() - started < env.POST_CLICK_VERIFY_MS) {
    // 1. Success Toast
    try {
      const okMsg = page.locator('text=/approved|executed|success|processing|pending|confirmed|done/i').first();
      if (await okMsg.count()) { 
        const text = await okMsg.textContent().catch(() => "");
        via = 'toast'; 
        logLine(`✓ Success: "${text.trim().slice(0, 50)}"`);
        break; 
      }
    } catch {}

    // 2. Button State
    try {
      const count = await targetBefore.count();
      if (count === 0) { 
        via = 'target-removed'; 
        logLine("✓ Target removed");
        break; 
      }
      
      const el = await targetBefore.elementHandle();
      if (!el) { 
        via = 'target-gone'; 
        logLine("✓ Target gone");
        break; 
      }
      
      const tagName = await el.evaluate(node => node.tagName).catch(() => "");
      if (tagName === "BUTTON") {
        const disabled = await el.getAttribute("disabled");
        if (disabled !== null) { 
          via = 'disabled'; 
          logLine("✓ Button disabled");
          break; 
        }
        
        const text = (await el.textContent())?.trim().toLowerCase() || "";
        if (text !== "approve" && text !== "") {
          via = 'text-changed'; 
          logLine(`✓ Button text: "${text}"`);
          break;
        }
      }
    } catch {}

    // 3. Network
    const resp = await page.waitForResponse(r => {
      const url = r.url();
      const method = r.request().method();
      const match = netRe.test(url) && method !== 'OPTIONS';
      if (match) {
        logLine(`🌐 ${method} ${url.slice(0, 80)} → ${r.status()}`);
      }
      return match && r.ok();
    }, { timeout: 250 }).catch(() => null);
    
    if (resp) { 
      via = 'net-ok'; 
      break; 
    }

    await page.waitForTimeout(150);
  }

  const elapsed = Date.now() - started;
  const ok = env.STRICT_VERIFY ? (via === 'net-ok') : !!via;
  logLine(`Verify: ${ok ? '✅' : '❌'} via "${via || 'timeout'}" (${elapsed}ms)`);
  
  return { ok, via: via || 'timeout' };
}

async function tryApproveOnDashboard(page) {
  await page.waitForTimeout(300);

  // DEBUG: Screenshot BEFORE overlay removal
  if (env.DEBUG_SHOTS) {
    try {
      await page.screenshot({ 
        path: path.join(DEBUG_DIR, `before-dismiss-${Date.now()}.png`),
        fullPage: true 
      });
    } catch {}
  }

  // KILL ALL OVERLAYS
  await dismissOverlays(page);
  await page.waitForTimeout(200);

  // DEBUG: Screenshot AFTER overlay removal
  if (env.DEBUG_SHOTS) {
    try {
      await page.screenshot({ 
        path: path.join(DEBUG_DIR, `after-dismiss-${Date.now()}.png`),
        fullPage: true 
      });
    } catch {}
  }

  for (const scope of allScopes(page)) {
    const targets = await findApproveTargets(scope);
    
    logLine(`Found ${targets.length} potential targets`);
    
    if (targets.length === 0) continue;

    for (const target of targets) {
      const { locator, why, type } = target;
      
      logLine(`🎯 Trying: ${why} (${type})`);
      
      try {
        const isVisible = await locator.isVisible().catch(() => false);
        const box = await locator.boundingBox().catch(() => null);
        
        logLine(`   visible=${isVisible}, box=${box ? `${Math.round(box.x)},${Math.round(box.y)}` : 'none'}`);
        
        if (!isVisible && !box) {
          logLine("   ⚠ Not visible, skipping");
          continue;
        }
      } catch (e) {
        logLine("   ⚠ Inspection failed:", e.message.slice(0, 60));
      }

      const clickWay = await clickRobust(scope, locator, type);
      
      if (!clickWay) {
        logLine("   ❌ All click methods failed");
        continue;
      }

      await page.waitForTimeout(300);
      await maybeConfirm(scope);
      await page.waitForTimeout(env.CLICK_WAIT_MS);

      const verdict = await verifyApproved(scope, locator);

      if (env.DEBUG_SHOTS) {
        const base = path.join(DEBUG_DIR, `click-${Date.now()}-${verdict.ok ? 'OK' : 'FAIL'}`);
        try {
          await page.screenshot({ path: `${base}.png`, fullPage: true });
          fs.writeFileSync(`${base}.html`, await page.content());
          logLine(`📸 ${path.basename(base)}`);
        } catch {}
      }

      if (verdict.ok) return true;
      
      logLine(`   ⚠ Verify failed (${verdict.via}), trying next...`);
    }
  }
  
  return false;
}

async function approveOne(opts = { fast: true, signalTime: null }) {
  if (opts.signalTime) {
    const ageMs = Date.now() - opts.signalTime;
    const ageSec = Math.round(ageMs / 1000);
    
    if (ageSec > env.MAX_AGE_SEC) {
      logLine(`⏰ Signal too old: ${ageSec}s > ${env.MAX_AGE_SEC}s`);
      return { ok: false, reason: "SIGNAL_TOO_OLD", ageSec };
    }
    
    logLine(`⏱️ Signal age: ${ageSec}s (max ${env.MAX_AGE_SEC}s)`);
  }
  
  if (!inWindow()) return { ok:false, reason:"OUTSIDE_WINDOW" };
  if (approvesToday >= env.MAX_PER_DAY) return { ok:false, reason:"DAILY_LIMIT" };
  if (busy) return { ok:false, reason:"BUSY" };

  busy = true;
  try {
    return await withCtx(async (page) => {
      if (opts.fast) {
        await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS });
        await dismissOverlays(page).catch(()=>{});
        logLine(`[${ts()} fast] url=`, page.url());
        
        if (onLoginUrl(page)) return { ok:false, reason:"LOGIN_REQUIRED" };

        logLine("🔄 Guaranteed refresh");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 2500 });
        await dismissOverlays(page).catch(()=>{});
        await page.waitForTimeout(300);

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

      // SLOW MODE
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
        
        if (i < 4) {
          logLine(`Reload attempt ${i + 2}/5`);
          await page.reload({ waitUntil: "domcontentloaded" }).catch(()=>{});
          await page.waitForTimeout(400);
        }
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

// ---------- Heartbeat ----------
const rnd = (a,b)=> Math.floor(Math.random()*(b-a+1))+a;
async function heartbeat(){
  if (!inWindow()) return;
  try {
    await withCtx(async (page) => {
      await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(()=>{});
      await dismissOverlays(page).catch(()=>{});
      if (onLoginUrl(page) && env.EMAIL && env.PASSWORD) await ensureOnDashboard(page).catch(()=>{});
    });
    logLine("🔄 Heartbeat OK");
  } catch(e){ logLine("Heartbeat ERR:", e.message); }
}
function scheduleNextHeartbeat() {
  const minMs = env.HEARTBEAT_MIN_MIN * 60_000;
  const maxMs = env.HEARTBEAT_MAX_MIN * 60_000;
  const jitter = rnd(0, 20) * 1000;
  const delay = rnd(minMs, maxMs) + jitter;
  logLine(`⏰ Next heartbeat in ~${(delay/60000).toFixed(1)} min`);
  setTimeout(async () => { await heartbeat(); scheduleNextHeartbeat(); }, delay);
}

cron.schedule("0 0 * * *", () => { approvesToday = 0; logLine("📅 Daily counter reset"); }, { timezone: "UTC" });

// ---------- HTTP ----------
const app = express();

function checkAuth(req,res,next){
  if (!env.AUTH_TOKEN) return next();
  const token = req.headers["x-auth"] || req.query.auth;
  if (token !== env.AUTH_TOKEN) return res.status(401).json({ ok:false, reason:"UNAUTHORIZED" });
  next();
}

app.get("/approve", checkAuth, async (_req,res)=> res.json(await approveOne({ fast:false, signalTime: Date.now() })));
app.get("/approve-fast", checkAuth, async (_req,res)=> res.json(await approveOne({ fast:true, signalTime: Date.now() })));

app.get("/login-status", checkAuth, async (_req,res)=>{
  try{
    const r = await withCtx(async page=>{
      await page.goto(env.DASH_URL, { waitUntil:"domcontentloaded", timeout: env.FAST_LOAD_MS });
      if (onLoginUrl(page)) return (await ensureOnDashboard(page)) ? "OK" : "LOGIN_REQUIRED";
      return "OK";
    });
    res.json({ ok:true, status:r });
  } catch(e){ res.json({ ok:false, error:e.message }); }
});

app.get("/health", (_req,res)=> res.json({
  ok:true,
  window:`${env.WINDOW_START}-${env.WINDOW_END} UTC`,
  hb:`${env.HEARTBEAT_MIN_MIN}-${env.HEARTBEAT_MAX_MIN} min`,
  maxAgeSec: env.MAX_AGE_SEC,
  approvesToday
}));

app.post("/hook/telegram", checkAuth, express.json({ limit: "64kb" }), async (req, res) => {
  const signalTime = Date.now();
  
  try { 
    const msg = (req.body && req.body.message) ? String(req.body.message) : ""; 
    logLine("📨 Signal received:", msg.slice(0, 160)); 
  } catch {}
  
  res.json({ ok: true, queued: true });

  (async () => {
    let rFast = null;
    try { 
      rFast = await approveOne({ fast: true, signalTime }); 
      logLine("approve-async fast:", rFast); 
    } catch (e) { 
      logLine("approve-async fast error:", e.message); 
    }
    
    if (rFast && rFast.reason === "SIGNAL_TOO_OLD") {
      logLine("⏰ Skipping fallback (too old)");
      return;
    }
    
    if (!rFast || (rFast.ok === false && (rFast.reason === "NO_BUTTON" || rFast.reason === "LOGIN_REQUIRED"))) {
      const ageSec = Math.round((Date.now() - signalTime) / 1000);
      if (ageSec > env.MAX_AGE_SEC) {
        logLine(`⏰ Skipping fallback (age ${ageSec}s)`);
        return;
      }
      
      try { 
        const r2 = await approveOne({ fast: false, signalTime }); 
        logLine("approve-async fallback:", r2); 
      } catch (e) { 
        logLine("approve-async fallback error:", e.message); 
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
        const url = fr.url ? fr.url() : "main-page";
        const counts = {};
        counts.roundedBox = await fr.locator('.rounded-box-5 button.btn-white').filter({ hasText: /approve/i }).count();
        counts.signals = await fr.locator('#signals button').filter({ hasText: /approve/i }).count();
        counts.btnWhite = await fr.locator('button.btn-white').filter({ hasText: /approve/i }).count();
        counts.roleButton = await fr.getByRole("button", { name: /^approve$/i }).count();
        counts.textNodes = await fr.getByText(/^Approve\s*$/i).count();
        data.push({ frameUrl: url, counts });
      }
      return data;
    });
    res.json({ ok:true, frames: out });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get("/debug/button-inspect", checkAuth, async (_req, res) => {
  try {
    const out = await withCtx(async (page) => {
      await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(()=>{});
      await dismissOverlays(page).catch(()=>{});
      
      const results = [];
      for (const scope of allScopes(page)) {
        const targets = await findApproveTargets(scope);
        
        for (const { locator, why, type } of targets) {
          const el = await locator.elementHandle().catch(() => null);
          if (!el) continue;
          
          const details = await page.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const styles = window.getComputedStyle(node);
            return {
              text: node.textContent.trim(),
              tagName: node.tagName,
              classes: node.className,
              id: node.id,
              disabled: node.disabled,
              visible: styles.visibility !== 'hidden' && styles.display !== 'none',
              opacity: styles.opacity,
              zIndex: styles.zIndex,
              pointerEvents: styles.pointerEvents,
              position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
            };
          }, el).catch(() => ({}));
          
          results.push({ selector: why, type, ...details });
        }
      }
      
      return results;
    });
    res.json({ ok: true, buttons: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/debug/shots", checkAuth, (_req, res) => {
  try {
    const files = fs.readdirSync(DEBUG_DIR)
      .filter(f => f.endsWith(".png") || f.endsWith(".html"))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(DEBUG_DIR, f)).mtimeMs }))
      .sort((a,b) => b.mtime - a.mtime)
      .slice(0, 50);
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

// ---------- Start ----------
app.listen(Number(env.PORT), () => {
  logLine(`🚀 Approver Service up on port ${env.PORT}`);
  logLine(`⏰ Window: ${env.WINDOW_START}-${env.WINDOW_END} UTC`);
  logLine(`💓 Heartbeat: ${env.HEARTBEAT_MIN_MIN}-${env.HEARTBEAT_MAX_MIN} min`);
  logLine(`⏱️ Max signal age: ${env.MAX_AGE_SEC}s`);
  logLine(`🎯 Strategy: Nuclear overlay killer + guaranteed refresh + mouse-first`);
  scheduleNextHeartbeat();
});
