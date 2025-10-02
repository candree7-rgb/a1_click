// index.js — ULTIMATE A1 Approver: Nuclear Overlays + Popup Double-Approve + Cookie Persistence

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
  CLICK_WAIT_MS: Number(process.env.CLICK_WAIT_MS || "800"),
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

// ---------- NUCLEAR OVERLAY KILLER ----------
async function dismissOverlays(page) {
  // LAYER 0: Cookie Policy Dialog (AlgosOne specific)
  try {
    const hasCookiePolicy = await page.locator('text="COOKIE POLICY"').count() > 0;
    if (hasCookiePolicy) {
      logLine("🍪 Cookie Policy dialog detected! KILLING...");
      
      // 1. Back button
      const backBtn = page.getByRole("button", { name: /back/i }).first();
      if (await backBtn.count() > 0) {
        await backBtn.click({ timeout: 800 }).catch(() => {});
        logLine("✓ Clicked Back");
      }
      
      // 2. Escape key
      await page.keyboard.press("Escape").catch(() => {});
      
      // 3. Nuclear: Remove via JS
      await page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"], .modal, [class*="modal"]');
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

  // LAYER 1: Cookie Banner (bottom bar with Accept/Decline)
  try {
    const cookieBanner = page.locator('text=/We use.*cookies|Cookie Policy/i')
      .locator('..')
      .locator('button:has-text("Accept"), button:has-text("Agree"), button:has-text("Preferences")')
      .first();
    
    if (await cookieBanner.count() > 0) {
      logLine("🍪 Accepting cookie banner...");
      await cookieBanner.click({ timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(200);
      
      // Save cookies immediately
      try {
        await page.context().storageState({ path: STORAGE_PATH });
        logLine("✅ Cookie consent saved");
      } catch {}
    }
  } catch {}

  // LAYER 2: Standard overlays
  const standardOverlays = [
    page.getByRole("button", { name: /accept all|accept|agree|got it|okay|ok|verstanden/i }).first(),
    page.locator('button:has-text("Accept")').first(),
  ];
  
  for (const btn of standardOverlays) {
    try {
      if (await btn.count() > 0) {
        await btn.click({ timeout: 800 }).catch(() => {});
        await page.waitForTimeout(100);
      }
    } catch {}
  }

  // LAYER 3: Generic dialogs
  try {
    const dialogs = await page.locator('[role="dialog"], .modal, .popup').all();
    for (const dialog of dialogs) {
      try {
        const isVisible = await dialog.isVisible().catch(() => false);
        if (!isVisible) continue;
        
        const closeBtn = dialog.locator('button:has-text("×"), button:has-text("Close"), [aria-label="Close"]').first();
        if (await closeBtn.count() > 0) {
          await closeBtn.click({ timeout: 500 }).catch(() => {});
        } else {
          await dialog.evaluate(el => el.remove()).catch(() => {});
        }
      } catch {}
    }
  } catch {}

  // LAYER 4: NUCLEAR - Remove all high z-index overlays
  try {
    const removed = await page.evaluate(() => {
      let count = 0;
      const allElements = Array.from(document.querySelectorAll('*'));
      
      // Find high z-index positioned elements
      const overlays = allElements.filter(el => {
        const style = window.getComputedStyle(el);
        const z = parseInt(style.zIndex);
        const pos = style.position;
        return !isNaN(z) && z > 500 && (pos === 'fixed' || pos === 'absolute');
      });
      
      overlays.forEach(el => {
        const rect = el.getBoundingClientRect();
        const coversScreen = rect.width > window.innerWidth * 0.5 || rect.height > window.innerHeight * 0.5;
        if (coversScreen) {
          el.remove();
          count++;
        }
      });
      
      // Backdrops
      const backdrops = document.querySelectorAll('.backdrop, .overlay, [class*="backdrop"], [class*="overlay"]');
      backdrops.forEach(b => {
        if (parseInt(window.getComputedStyle(b).zIndex) > 100) {
          b.remove();
          count++;
        }
      });
      
      return count;
    }).catch(() => 0);
    
    if (removed > 0) {
      logLine(`🗑️ Nuclear: removed ${removed} overlays`);
    }
  } catch {}
}

// ---------- POPUP APPROVE (Blue Button) ----------
async function maybeConfirm(page) {
  // LAYER 1: "Trade to approve" Popup (das ist der blaue Button!)
  try {
    const tradePopup = page.locator('text="Trade to approve"').first();
    const hasPopup = await tradePopup.count() > 0;
    
    if (hasPopup) {
      logLine("🎯 'Trade to approve' popup detected!");
      
      // Kurz warten (Popup-Animation)
      await page.waitForTimeout(300);
      
      // Finde BLAUEN Approve Button im Popup
      const blueApprove = page.locator('[role="dialog"] button, dialog button')
        .filter({ hasText: /^approve$/i })
        .first();
      
      if (await blueApprove.count() > 0) {
        logLine("🔵 Clicking BLUE Approve in popup...");
        
        // Mouse-Click (robuster)
        const box = await blueApprove.boundingBox().catch(() => null);
        if (box) {
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          
          await page.mouse.move(x, y);
          await page.waitForTimeout(100);
          await page.mouse.click(x, y);
          
          logLine("✅ Blue Approve clicked!");
          await page.waitForTimeout(800); // Warte auf Trade-Execution
          return true;
        }
        
        // Fallback: Normal click
        await blueApprove.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(800);
        return true;
      } else {
        logLine("⚠️ Blue Approve not found in popup");
      }
    }
  } catch (e) {
    logLine("Popup approve error:", e.message.slice(0, 60));
  }
  
  // LAYER 2: Generic confirm dialogs
  try {
    const dlg = page.getByRole("dialog");
    if (await dlg.count() === 0) return false;
    
    const btn = dlg.getByRole("button", { name: /^(confirm|yes|ok|continue|approve)$/i }).first();
    if (await btn.count() > 0) { 
      logLine("✅ Generic confirm button");
      await btn.click().catch(() => {}); 
      await page.waitForTimeout(200); 
      return true;
    }
  } catch {}
  
  return false;
}

// ---------- Login ----------
async function loginWithPassword(page) {
  await page.goto(env.LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await dismissOverlays(page).catch(() => {});
  
  const email = page.getByLabel(/email/i)
    .or(page.getByPlaceholder(/email|e-mail/i))
    .or(page.locator('input[type="email"]'))
    .first();
  const pass = page.getByLabel(/password|passwort/i)
    .or(page.getByPlaceholder(/password|passwort/i))
    .or(page.locator('input[type="password"]'))
    .first();
  
  await email.waitFor({ state: "visible", timeout: 20000 }); 
  await email.fill(env.EMAIL);
  await pass.waitFor({ state: "visible", timeout: 20000 });  
  await pass.fill(env.PASSWORD);
  
  const submit = page.getByRole("button", { name: /sign in|log in|anmelden|login|continue/i })
    .first()
    .or(page.locator('button[type="submit"]'))
    .first();
  
  await submit.click({ timeout: 20000 }).catch(async () => { 
    await pass.press("Enter"); 
  });
  
  await page.waitForLoadState("networkidle", { timeout: 90000 });
  await dismissOverlays(page).catch(() => {});
  await page.waitForURL(/app\.algosone\.ai\/(dash|dashboard)/i, { timeout: 90000 }).catch(() => {});
}

async function loginWithGoogle(page) {
  await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await dismissOverlays(page).catch(() => {});
  await page.getByRole("button", { name: /google|continue with google|sign in with google/i })
    .first()
    .click({ timeout: 20000 });
  await page.waitForURL(/accounts\.google\.com/i, { timeout: 90000 });
  await page.getByRole("textbox", { name: /email|phone|e-mail/i }).fill(env.EMAIL);
  await page.getByRole("button", { name: /next|weiter/i }).click();
  await page.getByRole("textbox", { name: /password|passwort/i }).fill(env.PASSWORD);
  await page.getByRole("button", { name: /next|weiter/i }).click();
  await page.waitForURL(/app\.algosone\.ai\/(dash|dashboard)/i, { timeout: 90000 });
  await dismissOverlays(page).catch(() => {});
}

async function ensureOnDashboard(page) {
  await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(() => {});
  await dismissOverlays(page).catch(() => {});
  
  if (!onLoginUrl(page)) return true;

  await page.goto(env.LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
  await dismissOverlays(page).catch(() => {});
  
  if (!env.EMAIL || !env.PASSWORD) return false;
  
  try { 
    (env.LOGIN_METHOD === "google") ? await loginWithGoogle(page) : await loginWithPassword(page); 
  } catch { 
    return false; 
  }
  
  await dismissOverlays(page).catch(() => {});
  return !onLoginUrl(page);
}

// ---------- Approve Logic ----------
function allScopes(page) { return [page, ...page.frames()]; }

async function findApproveTargets(scope) {
  const targets = [];
  
  const selectors = [
    { sel: scope.locator('.rounded-box-5 button.btn-white').filter({ hasText: /^approve$/i }), why: 'rounded-box' },
    { sel: scope.locator('#signals .d-flex.text-end button.btn-white').filter({ hasText: /^approve$/i }), why: '#signals' },
    { sel: scope.locator('button.btn-white').filter({ hasText: /^approve$/i }), why: 'btn-white' },
  ];
  
  const section = scope.locator("section,div,article").filter({ hasText: /1[- ]?click trade/i }).first();
  if (await section.count() > 0) {
    selectors.push({ sel: section.locator('button').filter({ hasText: /^approve$/i }), why: '1-click-section' });
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
  
  const textNodes = await scope.getByText(/^Approve\s*$/i).all();
  for (let i = 0; i < textNodes.length; i++) {
    targets.push({ locator: textNodes[i], why: `text[${i}]`, type: 'text' });
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
  
  // PRIO 1: MOUSE (ignores overlays)
  if (box && box.width > 0 && box.height > 0) {
    try {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      
      logLine(`🖱️ Mouse at ${Math.round(x)},${Math.round(y)}`);
      
      // Hide high-z overlays right before click
      await page.evaluate(() => {
        document.querySelectorAll('*').forEach(el => {
          const z = parseInt(window.getComputedStyle(el).zIndex);
          if (!isNaN(z) && z > 900) el.style.display = 'none';
        });
      }).catch(() => {});
      
      await page.mouse.move(x, y);
      await page.waitForTimeout(80);
      await page.mouse.down();
      await page.waitForTimeout(60);
      await page.mouse.up();
      await page.waitForTimeout(150);
      
      logLine("✓ mouse-click");
      return 'mouse-click';
    } catch (e) {
      logLine("⚠ mouse failed:", e.message.slice(0, 60));
    }
  }
  
  // PRIO 2-5: Fallbacks
  const fallbacks = [
    { name: 'force', fn: async () => locator.click({ timeout: 1500, force: true, delay: 80 }) },
    { name: 'js-events', fn: async () => {
      const el = await locator.elementHandle();
      if (!el) return;
      await page.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        ['mousedown', 'mouseup', 'click'].forEach(type => {
          node.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2
          }));
        });
        node.click();
      }, el);
    }},
    { name: 'normal', fn: async () => locator.click({ timeout: 1000, delay: 80 }) },
    { name: 'dbl', fn: async () => locator.dblclick({ timeout: 1000, force: true }) },
  ];
  
  for (const { name, fn } of fallbacks) {
    try {
      await fn();
      await page.waitForTimeout(150);
      logLine(`✓ ${name}-click`);
      return name;
    } catch (e) {
      logLine(`⚠ ${name} failed:`, e.message.slice(0, 60));
    }
  }
  
  return null;
}

async function verifyApproved(page, targetBefore) {
  const started = Date.now();
  const netRe = new RegExp(env.NET_OK_REGEX, "i");
  let via = null;

  while (Date.now() - started < env.POST_CLICK_VERIFY_MS) {
    // 1. Toast
    try {
      const okMsg = page.locator('text=/approved|executed|success|processing|confirmed|done/i').first();
      if (await okMsg.count()) { 
        const text = await okMsg.textContent().catch(() => "");
        via = 'toast'; 
        logLine(`✓ Toast: "${text.trim().slice(0, 50)}"`);
        break; 
      }
    } catch {}

    // 2. Button state
    try {
      if (await targetBefore.count() === 0) { 
        via = 'removed'; 
        logLine("✓ Button removed");
        break; 
      }
      
      const el = await targetBefore.elementHandle();
      if (!el) { 
        via = 'gone'; 
        logLine("✓ Element gone");
        break; 
      }
      
      if (await el.evaluate(node => node.tagName).catch(() => "") === "BUTTON") {
        if (await el.getAttribute("disabled") !== null) { 
          via = 'disabled'; 
          logLine("✓ Disabled");
          break; 
        }
        
        const text = (await el.textContent())?.trim().toLowerCase() || "";
        if (text !== "approve" && text !== "") {
          via = 'text-changed'; 
          logLine(`✓ Text: "${text}"`);
          break;
        }
      }
    } catch {}

    // 3. Network
    const resp = await page.waitForResponse(r => {
      const url = r.url();
      const match = netRe.test(url) && r.request().method() !== 'OPTIONS';
      if (match) logLine(`🌐 ${r.request().method()} ${url.slice(0, 60)} → ${r.status()}`);
      return match && r.ok();
    }, { timeout: 250 }).catch(() => null);
    
    if (resp) { 
      via = 'net'; 
      break; 
    }

    await page.waitForTimeout(150);
  }

  const elapsed = Date.now() - started;
  const ok = env.STRICT_VERIFY ? (via === 'net') : !!via;
  logLine(`Verify: ${ok ? '✅' : '❌'} via "${via || 'timeout'}" (${elapsed}ms)`);
  
  return { ok, via: via || 'timeout' };
}

async function tryApproveOnDashboard(page) {
  await page.waitForTimeout(300);
  await dismissOverlays(page);
  await page.waitForTimeout(200);

  for (const scope of allScopes(page)) {
    const targets = await findApproveTargets(scope);
    logLine(`Found ${targets.length} targets`);
    
    if (targets.length === 0) continue;

    for (const target of targets) {
      const { locator, why, type } = target;
      logLine(`🎯 ${why} (${type})`);
      
      const isVisible = await locator.isVisible().catch(() => false);
      const box = await locator.boundingBox().catch(() => null);
      logLine(`   visible=${isVisible}, box=${box ? 'yes' : 'no'}`);
      
      if (!isVisible && !box) {
        logLine("   ⚠ Not visible");
        continue;
      }

      const clickWay = await clickRobust(scope, locator, type);
      if (!clickWay) {
        logLine("   ❌ All clicks failed");
        continue;
      }

      // WICHTIG: Warte auf Popup!
      await page.waitForTimeout(500);
      
      // Check & Click blue Approve (if popup exists)
      const popupClicked = await maybeConfirm(page);
      
      if (popupClicked) {
        logLine("✅ Popup approved!");
        await page.waitForTimeout(1000); // Länger warten nach Popup-Click
      } else {
        await page.waitForTimeout(env.CLICK_WAIT_MS);
      }

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
      logLine(`   ⚠ Verify failed (${verdict.via})`);
    }
  }
  
  return false;
}

async function approveOne(opts = { fast: true, signalTime: null }) {
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
        await dismissOverlays(page).catch(() => {});
        logLine(`[${ts()} fast] ${page.url()}`);
        
        if (onLoginUrl(page)) return { ok: false, reason: "LOGIN_REQ" };

        logLine("🔄 Refresh");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 2500 });
        await dismissOverlays(page).catch(() => {});
        await page.waitForTimeout(300);

        if (await tryApproveOnDashboard(page)) {
          approvesToday++;
          return { ok: true, reason: "FAST" };
        }

        if (env.DEBUG_SHOTS) {
          const base = path.join(DEBUG_DIR, `no-btn-fast-${Date.now()}`);
          await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
          fs.writeFileSync(`${base}.html`, await page.content()).catch(() => {});
        }
        return { ok: false, reason: "NO_BUTTON" };
      }

      // SLOW
      const logged = await ensureOnDashboard(page);
      if (!logged) return { ok: false, reason: "LOGIN_REQ" };

      for (let i = 0; i < 5; i++) {
        if (await tryApproveOnDashboard(page)) { 
          approvesToday++; 
          return { ok: true, reason: i === 0 ? "DIRECT" : "REFRESH" }; 
        }

        const bell = page.getByRole("button", { name: /notifications|bell/i }).first();
        if (await bell.count()) {
          await bell.click().catch(() => {});
          await page.waitForTimeout(400);
          if (await tryApproveOnDashboard(page)) { 
            approvesToday++; 
            return { ok: true, reason: "BELL" }; 
          }
        }
        
        if (i < 4) {
          logLine(`Retry ${i + 2}/5`);
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          await page.waitForTimeout(400);
        }
      }

      if (env.DEBUG_SHOTS) {
        const base = path.join(DEBUG_DIR, `no-btn-${Date.now()}`);
        await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
        fs.writeFileSync(`${base}.html`, await page.content()).catch(() => {});
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
      
      // Nur bei Login dismissOverlays (sonst Cookies schon da)
      if (onLoginUrl(page)) {
        if (env.EMAIL && env.PASSWORD) {
          await ensureOnDashboard(page).catch(() => {});
        }
      }
    });
    logLine("🔄 Heartbeat OK");
  } catch(e){ 
    logLine("Heartbeat ERR:", e.message); 
  }
}

function scheduleNextHeartbeat() {
  const delay = rnd(env.HEARTBEAT_MIN_MIN * 60000, env.HEARTBEAT_MAX_MIN * 60000) + rnd(0, 20000);
  logLine(`⏰ Next HB in ~${(delay / 60000).toFixed(1)}min`);
  setTimeout(async () => { 
    await heartbeat(); 
    scheduleNextHeartbeat(); 
  }, delay);
}

cron.schedule("0 0 * * *", () => { 
  approvesToday = 0; 
  logLine("📅 Reset counter"); 
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
      if (onLoginUrl(page)) return (await ensureOnDashboard(page)) ? "OK" : "FAIL";
      return "OK";
    });
    res.json({ ok: true, status: r });
  } catch(e) { 
    res.json({ ok: false, error: e.message }); 
  }
});

app.get("/health", (_req, res) => res.json({
  ok: true,
  window: `${env.WINDOW_START}-${env.WINDOW_END} UTC`,
  hb: `${env.HEARTBEAT_MIN_MIN}-${env.HEARTBEAT_MAX_MIN}min`,
  maxAge: env.MAX_AGE_SEC,
  today: approvesToday
}));

app.post("/hook/telegram", checkAuth, express.json({ limit: "64kb" }), async (req, res) => {
  const signalTime = Date.now();
  
  try { 
    const msg = (req.body?.message) ? String(req.body.message) : ""; 
    logLine("📨 Signal:", msg.slice(0, 100)); 
  } catch {}
  
  res.json({ ok: true, queued: true });

  (async () => {
    let rFast = null;
    try { 
      rFast = await approveOne({ fast: true, signalTime }); 
      logLine("async fast:", rFast); 
    } catch (e) { 
      logLine("async fast err:", e.message); 
    }
    
    if (rFast?.reason === "TOO_OLD") {
      logLine("⏰ Skip fallback");
      return;
    }
    
    if (!rFast || (rFast.ok === false && (rFast.reason === "NO_BUTTON" || rFast.reason === "LOGIN_REQ"))) {
      const ageSec = Math.round((Date.now() - signalTime) / 1000);
      if (ageSec > env.MAX_AGE_SEC) {
        logLine(`⏰ Skip fallback (${ageSec}s)`);
        return;
      }
      
      try { 
        const r2 = await approveOne({ fast: false, signalTime }); 
        logLine("async fallback:", r2); 
      } catch (e) { 
        logLine("async fallback err:", e.message); 
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
      await dismissOverlays(page).catch(() => {});
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
      await dismissOverlays(page).catch(() => {});
      const data = [];
      for (const fr of allScopes(page)) {
        const url = fr.url ? fr.url() : "main";
        const counts = {
          roundedBox: await fr.locator('.rounded-box-5 button.btn-white').filter({ hasText: /approve/i }).count(),
          signals: await fr.locator('#signals button').filter({ hasText: /approve/i }).count(),
          btnWhite: await fr.locator('button.btn-white').filter({ hasText: /approve/i }).count(),
          role: await fr.getByRole("button", { name: /^approve$/i }).count(),
          text: await fr.getByText(/^Approve\s*$/i).count(),
        };
        data.push({ frameUrl: url, counts });
      }
      return data;
    });
    res.json({ ok: true, frames: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/debug/button-inspect", checkAuth, async (_req, res) => {
  try {
    const out = await withCtx(async (page) => {
      await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(() => {});
      await dismissOverlays(page).catch(() => {});
      
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
              tag: node.tagName,
              class: node.className,
              disabled: node.disabled,
              visible: styles.visibility !== 'hidden' && styles.display !== 'none',
              z: styles.zIndex,
              pos: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
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
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 50);
    res.json({ ok: true, dir: "/debug", files });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/debug/file/:name", checkAuth, (req, res) => {
  try {
    const safe = (req.params.name || "").replace(/[^a-zA-Z0-9._-]/g, "");
    const full = path.join(DEBUG_DIR, safe);
    if (!full.startsWith(DEBUG_DIR)) return res.status(400).json({ ok: false, error: "Bad path" });
    if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: "Not found" });
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
  logLine(`🚀 Approver v2.0 on :${env.PORT}`);
  logLine(`⏰ ${env.WINDOW_START}-${env.WINDOW_END} UTC`);
  logLine(`💓 HB: ${env.HEARTBEAT_MIN_MIN}-${env.HEARTBEAT_MAX_MIN}min`);
  logLine(`⏱️ Max age: ${env.MAX_AGE_SEC}s`);
  logLine(`🎯 Nuclear overlays + Popup double-approve + Cookie persistence`);
  scheduleNextHeartbeat();
});
