import express from "express";
import bodyParser from "body-parser";
import cron from "node-cron";
import fs from "fs";
import { chromium } from "playwright";
import TelegramBot from "node-telegram-bot-api";

/* ================= ENV ================= */
const env = {
  PORT: process.env.PORT || "8080",

  // Betriebsfenster (UTC) – wenn immer an: 00:00–23:59
  WINDOW_START: process.env.WINDOW_START || "00:00",
  WINDOW_END: process.env.WINDOW_END || "23:59",
  HEARTBEAT_EVERY_MIN: Number(process.env.HEARTBEAT_EVERY_MIN || "30"),

  // AlgosOne URLs
  DASH_URL: process.env.DASH_URL || "https://app.algosone.ai/dashboard",
  LOGIN_URL: process.env.LOGIN_URL || "https://app.algosone.ai/login",

  // Auto-Re-Login
  LOGIN_METHOD: (process.env.LOGIN_METHOD || "password").toLowerCase(), // "password" | "google"
  EMAIL: process.env.EMAIL || "",
  PASSWORD: process.env.PASSWORD || "",

  // Security für HTTP-Endpunkte
  AUTH_TOKEN: process.env.AUTH_TOKEN || "",

  // Limits (praktisch aus)
  MAX_PER_DAY: Number(process.env.MAX_PER_DAY || "999999"),

  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_ALLOWED_CHAT_IDS: (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").split(",").map(s => s.trim()).filter(Boolean), // leer = alle
  TELEGRAM_USE_POLLING: (process.env.TELEGRAM_USE_POLLING || "true").toLowerCase() === "true", // true = Long Polling; false = Webhook
  PUBLIC_URL: process.env.PUBLIC_URL || "",              // z.B. https://deinservice.up.railway.app  (nur für Webhook)
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET || "tgsecret" // für Webhook Pfad
};

const STORAGE_PATH = "/app/storageState.json";
const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

/* Optionale Start-Cookies */
if (process.env.STORAGE_STATE_B64 && !fs.existsSync(STORAGE_PATH)) {
  fs.writeFileSync(STORAGE_PATH, Buffer.from(process.env.STORAGE_STATE_B64, "base64"));
}

/* ================= Helpers ================= */
let approvesToday = 0;
let busy = false;                           // einfacher Mutex: verhindert Überschneidungen
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

/* ================= Login-Flow ================= */
async function loginWithPassword(page) {
  await page.goto(env.LOGIN_URL, { waitUntil: "networkidle", timeout: 90000 });

  const email =
    page.getByLabel(/email/i)
      .or(page.getByPlaceholder(/email|e-mail/i))
      .or(page.locator('input[type="email"]'))
      .first();
  await email.fill(env.EMAIL, { timeout: 20000 });

  const pass =
    page.getByLabel(/password|passwort/i)
      .or(page.getByPlaceholder(/password|passwort/i))
      .or(page.locator('input[type="password"]'))
      .first();
  await pass.fill(env.PASSWORD, { timeout: 20000 });

  const submit =
    page.getByRole("button", { name: /sign in|log in|anmelden/i }).first()
      .or(page.locator('button[type="submit"]')).first();
  await submit.click({ timeout: 20000 });

  await page.waitForURL(/app\.algosone\.ai\/(dash|dashboard)/i, { timeout: 90000 });
}

async function loginWithGoogle(page) {
  await page.goto(env.DASH_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  const gBtn = page.getByRole("button", { name: /google|continue with google|sign in with google|weiter mit google/i }).first();
  await gBtn.click({ timeout: 20000 });

  await page.waitForURL(/accounts\.google\.com/i, { timeout: 90000 });
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

/* ================= Approve-Logik ================= */
async function tryApproveOnDashboard(page) {
  const oneClick = page.locator("section,div,article").filter({ hasText: /1[- ]?click trade|one[- ]?click/i }).first();

  const findApprove = async (scope) => {
    let b = scope.getByRole("button", { name: /^(approve|genehmigen)$/i }).first();
    if (await b.count() === 0) b = scope.locator('button:has-text("Approve"), button:has-text("Genehmigen")').first();
    return b;
  };

  let scope = (await oneClick.count()) > 0 ? oneClick : page;

  // A) Direkt
  let btn = await findApprove(scope);
  if (await btn.count() > 0) {
    await btn.click();
    const confirm = page.getByRole("button", { name: /confirm|yes|ok/i });
    if (await confirm.count() > 0) await confirm.click();
    return true;
  }

  // B) „New actions available“
  const newActions = page.locator("div,button,a").filter({ hasText: /new actions available/i }).first();
  if (await newActions.count() > 0) {
    await newActions.click();
    await page.waitForTimeout(1200);
    btn = await findApprove(scope);
    if (await btn.count() > 0) {
      await btn.click();
      const confirm = page.getByRole("button", { name: /confirm|yes|ok/i });
      if (await confirm.count() > 0) await confirm.click();
      return true;
    }
  }

  // C) Globaler Fallback
  btn = page.getByRole("button", { name: /^(approve|genehmigen)$/i }).first();
  if (await btn.count() === 0) btn = page.locator('button:has-text("Approve"), button:has-text("Genehmigen")').first();
  if (await btn.count() > 0) {
    await btn.click();
    const confirm = page.getByRole("button", { name: /confirm|yes|ok/i });
    if (await confirm.count() > 0) await confirm.click();
    return true;
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
      if (!logged) { busy = false; return { ok:false, reason:"LOGIN_REQUIRED" }; }

      for (let i = 0; i < 5; i++) {
        const ok = await tryApproveOnDashboard(page);
        if (ok) { approvesToday++; busy = false; return { ok:true, reason: i===0 ? "APPROVED_DIRECT" : "APPROVED_AFTER_REFRESH" }; }

        // Glocke probieren
        const bell = page.getByRole("button", { name: /notifications|bell/i }).first();
        if (await bell.count() > 0) {
          await bell.click().catch(()=>{});
          await page.waitForTimeout(800);
          const ok2 = await tryApproveOnDashboard(page);
          if (ok2) { approvesToday++; busy = false; return { ok:true, reason:"APPROVED_VIA_BELL" }; }
        }

        await page.reload({ waitUntil: "networkidle" });
      }

      try { await page.screenshot({ path: `no-approve-${Date.now()}.png`, fullPage: true }); } catch {}
      busy = false;
      return { ok:false, reason:"NO_BUTTON" };
    });
  } catch (e) {
    console.error("approveOne error:", e);
    busy = false;
    return { ok:false, reason:"ERROR", msg: e.message };
  }
}

/* ================= Heartbeat ================= */
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

/* ================= Express HTTP ================= */
const app = express();
app.use(bodyParser.json());

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

/* ================= Telegram Integration ================= */
let bot = null;

// Hilfsfunktion: check Chat erlaubnis
function isAllowedChat(id) {
  if (env.TELEGRAM_ALLOWED_CHAT_IDS.length === 0) return true;
  return env.TELEGRAM_ALLOWED_CHAT_IDS.includes(String(id));
}

// Bei neuer Nachricht Approve ausführen & zurückschreiben
async function handleTelegramUpdate(msg) {
  const chatId = msg.chat.id;
  if (!isAllowedChat(chatId)) return;

  // Jede Nachricht triggert Approve:
  const r = await approveOne();
  // Antworte zurück mit Kurzinfo
  try {
    await bot.sendMessage(chatId,
      r.ok ? `✅ ${r.reason}` : `❌ ${r.reason}${r.msg ? " – " + r.msg : ""}`);
  } catch {}
}

// Polling-Modus (einfach)
function initPolling() {
  bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: true });
  bot.on("message", handleTelegramUpdate);
  console.log("Telegram: polling gestartet.");
}

// Webhook-Modus (für echte Webhooks)
function initWebhook() {
  bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN);
  const path = `/tg/${env.TELEGRAM_WEBHOOK_SECRET}`;
  bot.setWebHook(`${env.PUBLIC_URL}${path}`);
  app.post(path, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  bot.on("message", handleTelegramUpdate);
  console.log(`Telegram: webhook aktiv auf ${env.PUBLIC_URL}${path}`);
}

// Starte Telegram, falls Token vorhanden
function startTelegram() {
  if (!env.TELEGRAM_BOT_TOKEN) { console.log("Telegram: kein BOT TOKEN gesetzt – Telegram deaktiviert."); return; }
  if (env.TELEGRAM_USE_POLLING) initPolling();
  else {
    if (!env.PUBLIC_URL) console.log("Telegram Webhook gewählt, aber PUBLIC_URL fehlt – wechsle auf polling.");
    (env.PUBLIC_URL ? initWebhook() : initPolling());
  }
}

/* ================= Start ================= */
app.listen(Number(env.PORT), () => {
  console.log(`Service up on ${env.PORT} | window ${env.WINDOW_START}-${env.WINDOW_END} UTC`);
  startTelegram();
});
