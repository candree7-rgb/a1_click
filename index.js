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
  HEARTBEAT_MIN_MIN: Number(process.env.HEARTBEAT_MIN_MIN || "7"),
  HEARTBEAT_MAX_MIN: Number(process.env.HEARTBEAT_MAX_MIN || "12"),
  MAX_PER_DAY: Number(process.env.MAX_PER_DAY || "999999"),

  // AlgosOne
  DASH_URL: process.env.DASH_URL || "https://app.algosone.ai/dashboard",
  LOGIN_URL: process.env.LOGIN_URL || "https://app.algosone.ai/login",
  LOGIN_METHOD: (process.env.LOGIN_METHOD || "password").toLowerCase(),
  EMAIL: process.env.EMAIL || "",
  PASSWORD: process.env.PASSWORD || "",

  // HTTP-Auth
  AUTH_TOKEN: process.env.AUTH_TOKEN || "",

  // Zeitlimits
  FAST_LOAD_MS: Number(process.env.FAST_LOAD_MS || "3000"),
  CLICK_WAIT_MS: Number(process.env.CLICK_WAIT_MS || "1500")
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
function onLoginUrl(page) { return /login/i.test(page.url()); }
function logHere(page, tag){ console.log(`[${tag}] url=${page.url()}`); }

// ---------- Browser Context ----------
let browserP = null;
let ctx = null;

async function getCtx() {
  if (!browserP) browserP = chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const browser = await browserP;
  if (!ctx) {
    const opts = { userAgent: DESKTOP_UA, viewport: { width:1366, height:820 } };
    if (fs.existsSync(STORAGE_PATH)) opts.storageState = STORAGE_PATH;
    ctx = await browser.newContext(opts);
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
  } finally { try { await page.close(); } catch {} }
}

// ---------- Approve ----------
async function tryApproveOnDashboard(page) {
  // direkte Rolle
  let btn = page.getByRole("button", { name: /^approve$/i }).first();
  if (await btn.count() > 0) {
    await btn.click().catch(()=>{});
    await page.waitForTimeout(env.CLICK_WAIT_MS);
    return true;
  }

  // Fallback via Text
  btn = page.locator("button:has-text('Approve')").first();
  if (await btn.count() > 0) {
    await btn.click().catch(()=>{});
    await page.waitForTimeout(env.CLICK_WAIT_MS);
    return true;
  }

  // Fallback via CSS-Klasse
  btn = page.locator("button.btn.btn-white").filter({ hasText: "Approve" }).first();
  if (await btn.count() > 0) {
    await btn.click().catch(()=>{});
    await page.waitForTimeout(env.CLICK_WAIT_MS);
    return true;
  }

  return false;
}

async function approveOne(opts={fast:true}) {
  if (!inWindow()) return { ok:false, reason:"OUTSIDE_WINDOW" };
  if (approvesToday >= env.MAX_PER_DAY) return { ok:false, reason:"DAILY_LIMIT" };
  if (busy) return { ok:false, reason:"BUSY" };
  busy = true;

  try {
    return await withCtx(async (page)=>{
      await page.goto(env.DASH_URL, { waitUntil:"domcontentloaded", timeout: env.FAST_LOAD_MS }).catch(()=>{});
      logHere(page, "approve:afterGoto");
      if (onLoginUrl(page)) return { ok:false, reason:"LOGIN_REQUIRED" };

      const ok = await tryApproveOnDashboard(page);
      if (ok) { approvesToday++; return { ok:true, reason:"APPROVED" }; }
      return { ok:false, reason:"NO_BUTTON" };
    });
  } finally { busy=false; }
}

// ---------- Heartbeat ----------
function randInt(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
let hbTimer=null;
function scheduleNextHeartbeat(){
  const delay = randInt(env.HEARTBEAT_MIN_MIN, env.HEARTBEAT_MAX_MIN) * 60*1000;
  console.log(`⏰ Next heartbeat in ~${(delay/60000).toFixed(1)} min`);
  hbTimer=setTimeout(async()=>{
    try{ await withCtx(p=>p.goto(env.DASH_URL)); console.log("🔄 HB OK"); }catch(e){}
    scheduleNextHeartbeat();
  },delay);
}

// ---------- HTTP ----------
const app=express();
function checkAuth(req,res,next){
  if (!env.AUTH_TOKEN) return next();
  const t=req.headers["x-auth"]||req.query.auth;
  if (t!==env.AUTH_TOKEN) return res.status(401).json({ok:false});
  next();
}
app.get("/approve",checkAuth,async(_q,res)=>res.json(await approveOne({fast:false})));
app.get("/approve-fast",checkAuth,async(_q,res)=>res.json(await approveOne({fast:true})));
app.post("/hook/telegram",checkAuth,express.json(),async(req,res)=>{
  console.log("Signal received:",req.body?.message?.slice(0,100));
  res.json({ok:true});
  let r=await approveOne({fast:true});
  console.log("approve-async:",r);
  if(!r.ok) console.log("❌ approve fallback:",r.reason);
});
app.listen(Number(env.PORT),()=>{console.log(`Approver Service up on ${env.PORT}`);scheduleNextHeartbeat();});
