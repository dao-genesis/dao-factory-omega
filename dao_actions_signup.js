#!/usr/bin/env node
/**
 * 道 · GitHub Actions 签到核心 v2 (omega.signup)
 */
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RUN_ID = process.env.RUN_ID || crypto.randomBytes(4).toString("hex");
const HEADLESS = process.env.HEADLESS !== "false";
const OUT_DIR = path.resolve("./output");
fs.mkdirSync(OUT_DIR, { recursive: true });

const log = (...a) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${RUN_ID}]`, ...a);
};
const sl = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const hex = (n) => crypto.randomBytes(n).toString("hex").slice(0, n * 2);

function httpRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const o = {
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search,
      method: opts.method || "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type": "application/json", ...opts.headers,
      },
      timeout: opts.timeout || 30000,
    };
    const req = https.request(o, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: d, headers: res.headers }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (opts.body) req.write(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

class Mail {
  constructor() { this.addr=""; this.token=""; this.provider=""; }
  async create() {
    try {
      const r = await httpRequest("https://api.internal.temp-mail.io/api/v3/email/new", {
        method: "POST", body: { min_name_length: 10, max_name_length: 10 },
      });
      if (r.status === 200 && r.body.email) {
        this.addr = r.body.email; this.token = r.body.token; this.provider = "temp-mail.io";
        log(`  email ${this.addr} [${this.provider}]`); return this.addr;
      }
    } catch (e) { log(`  temp-mail.io failed: ${e.message}`); }
    try {
      const dr = await httpRequest("https://api.mail.tm/domains");
      const domains = Array.isArray(dr.body) ? dr.body : (dr.body["hydra:member"] || []);
      const dom = domains[0]?.domain;
      if (!dom) throw new Error("no domain");
      const local = "dao" + hex(6); const pass = hex(8) + "Aa1!";
      const cr = await httpRequest("https://api.mail.tm/accounts", {
        method: "POST", body: { address: `${local}@${dom}`, password: pass },
      });
      if (cr.status >= 200 && cr.status < 300) {
        const tk = await httpRequest("https://api.mail.tm/token", {
          method: "POST", body: { address: `${local}@${dom}`, password: pass },
        });
        if (tk.body.token) {
          this.addr = `${local}@${dom}`; this.token = tk.body.token; this.provider = "mail.tm";
          log(`  email ${this.addr} [${this.provider}]`); return this.addr;
        }
      }
    } catch (e) { log(`  mail.tm failed: ${e.message}`); }
    const local = "dao" + hex(6);
    const dom = ["1secmail.com", "1secmail.org", "1secmail.net"][rnd(0, 2)];
    this.addr = `${local}@${dom}`; this.provider = "1secmail";
    log(`  email ${this.addr} [${this.provider}]`); return this.addr;
  }
  _parse(text) {
    const m = String(text).match(/\b(\d{6,8})\b/) || String(text).match(/verification code[^0-9]*([0-9]{4,8})/i);
    return m ? m[1] : null;
  }
  async waitCode(timeoutSec = 240) {
    const t0 = Date.now();
    log(`  等OTP (${this.provider}) 上限${timeoutSec}s...`);
    while ((Date.now() - t0) / 1000 < timeoutSec) {
      try {
        if (this.provider === "temp-mail.io") {
          const r = await httpRequest(`https://api.internal.temp-mail.io/api/v3/email/${this.addr}/messages`);
          if (Array.isArray(r.body)) for (const m of r.body) {
            const c = this._parse((m.body_text||"")+(m.body_html||"")+(m.subject||""));
            if (c) return c;
          }
        } else if (this.provider === "mail.tm") {
          const r = await httpRequest("https://api.mail.tm/messages", { headers: { Authorization: `Bearer ${this.token}` } });
          const list = (r.body && r.body["hydra:member"]) || (Array.isArray(r.body) ? r.body : []);
          for (const m of list) {
            const dr = await httpRequest(`https://api.mail.tm/messages/${m.id}`, { headers: { Authorization: `Bearer ${this.token}` } });
            const c = this._parse((dr.body.text||"")+(Array.isArray(dr.body.html)?dr.body.html.join(""):dr.body.html||"")+(dr.body.subject||""));
            if (c) return c;
          }
        } else if (this.provider === "1secmail") {
          const [u, d] = this.addr.split("@");
          const r = await httpRequest(`https://www.1secmail.com/api/v1/?action=getMessages&login=${u}&domain=${d}`);
          if (Array.isArray(r.body)) for (const m of r.body) {
            const dr = await httpRequest(`https://www.1secmail.com/api/v1/?action=readMessage&login=${u}&domain=${d}&id=${m.id}`);
            const c = this._parse((dr.body.textBody||"")+(dr.body.htmlBody||"")+(dr.body.subject||""));
            if (c) return c;
          }
        }
      } catch {}
      await sl(5000);
    }
    return null;
  }
}

async function diagSnapshot(page, tag) {
  try {
    const ss = path.join(OUT_DIR, `${tag}_${RUN_ID}.png`);
    await page.screenshot({ path: ss, fullPage: false }).catch(()=>{});
    const url = page.url();
    const frames = page.frames().map(f => f.url());
    const errMsgs = await page.evaluate(() => {
      const errs = [];
      for (const el of document.querySelectorAll('[class*="error"], [class*="danger"], [class*="alert"], [role="alert"]')) {
        const t = (el.textContent || "").trim();
        if (t && t.length < 200) errs.push(t);
      }
      return errs;
    }).catch(() => []);
    log(`  [diag ${tag}] url=${url}`);
    log(`  [diag ${tag}] frames(${frames.length}): ${frames.slice(0, 5).map(f => f.slice(0, 70)).join(" | ")}`);
    if (errMsgs.length) log(`  [diag ${tag}] errors: ${errMsgs.slice(0, 3).join(" | ")}`);
    return { url, frames, errMsgs };
  } catch (e) { log(`  [diag err] ${e.message}`); return {}; }
}

async function signup() {
  const mail = new Mail();
  await mail.create();
  const pass = hex(10) + "Aa1!Bb2@";
  const user = `dao-${hex(3)}-${rnd(100, 999)}`;
  log(`§1 启动浏览器 (headless=${HEADLESS})`);
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-US", timezoneId: "America/New_York",
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });
  const page = await ctx.newPage();
  let result = { ok: false, user, email: mail.addr, pass, provider: mail.provider, run_id: RUN_ID, diagnostics: [] };

  try {
    log(`§2 导航 github.com/signup`);
    await page.goto("https://github.com/signup", { waitUntil: "domcontentloaded", timeout: 60000 });
    await sl(3000);
    await diagSnapshot(page, "01_loaded");

    log(`§3 填表`);
    await page.locator("#email").first().fill(mail.addr);
    await sl(rnd(1500, 2500));
    await page.locator("#password").first().fill(pass);
    await sl(rnd(1500, 2500));
    await page.locator("#login").first().fill(user);
    await sl(rnd(3500, 5000));

    const countryBtn = page.locator('button[aria-label*="ountry"]').first();
    if (await countryBtn.isVisible().catch(() => false)) {
      await countryBtn.click(); await sl(1500);
      const usOpt = page.locator('[role="option"]:has-text("United States of America")').first();
      if (await usOpt.isVisible().catch(() => false)) {
        await usOpt.click(); await sl(2000);
      }
    }
    await diagSnapshot(page, "02_filled");

    log(`§4 点击 Create account`);
    const createBtn = page.locator('button:has-text("Create account")').first();
    await createBtn.click();
    await sl(3000);
    await diagSnapshot(page, "03_after_click");

    // §5 等待 CAPTCHA / POW，更长超时和更详细诊断
    log(`§5 等待 CAPTCHA/POW (sup=1) 最长240s`);
    let powDone = false;
    let lastUrl = page.url();
    for (let w = 0; w < 120; w++) {
      const url = page.url();
      if (url !== lastUrl) {
        log(`  url changed: ${lastUrl.slice(0,60)} -> ${url.slice(0,60)}`);
        lastUrl = url;
      }
      if (!url.includes("/signup") || url.includes("/welcome") || url.includes("verify")) {
        powDone = true;
        log(`  ✓ POW通过 url=${url.slice(0, 80)}`);
        break;
      }
      const otpVisible = await page
        .locator('input[name="email_verification_code"], input[autocomplete="one-time-code"]')
        .first().isVisible().catch(() => false);
      if (otpVisible) {
        powDone = true;
        log(`  ✓ POW通过 (OTP输入框出现)`);
        break;
      }
      // 每30s做一次诊断
      if (w > 0 && w % 15 === 0) {
        const d = await diagSnapshot(page, `05_wait_${w}`);
        result.diagnostics.push({ at: w*2 + "s", ...d });
        // 检查是否有 Arkose 框架
        const arkoseFrames = page.frames().filter((f) => f.url().includes("arkoselabs.com") || f.url().includes("funcaptcha"));
        if (arkoseFrames.length > 0) {
          log(`  Arkose iframes: ${arkoseFrames.length}`);
          for (const af of arkoseFrames) {
            try {
              const txt = await af.locator("body").textContent({ timeout: 2000 }).catch(() => "");
              log(`    [${af.url().slice(0,60)}] body text: ${(txt||"").slice(0,150)}`);
            } catch {}
          }
        }
      }
      await sl(2000);
    }
    if (!powDone) {
      log(`  ✗ POW超时 (240s)`);
      await diagSnapshot(page, "06_timeout");
      result.error = "pow_timeout"; await browser.close(); return result;
    }

    // §6 OTP
    log(`§6 OTP验证`);
    const code = await mail.waitCode(180);
    if (!code) { result.error = "no_otp"; await browser.close(); return result; }
    log(`  收到OTP: ${code}`);
    const otpInputs = await page.locator('input[autocomplete="one-time-code"], input[name="email_verification_code"]').all();
    if (otpInputs.length === 1) await otpInputs[0].fill(code);
    else if (otpInputs.length > 1) {
      for (let i = 0; i < Math.min(code.length, otpInputs.length); i++) await otpInputs[i].fill(code[i]);
    } else await page.keyboard.type(code, { delay: 80 });
    await sl(5000);

    // §7 验证登录态
    log(`§7 验证登录态`);
    let loggedIn = false;
    for (let w = 0; w < 15; w++) {
      const url = page.url();
      if (url.includes("/welcome") || url.includes("/dashboard") || (url === "https://github.com/" && !url.includes("/login"))) {
        loggedIn = true; break;
      }
      await sl(2000);
    }
    if (!loggedIn) {
      try {
        await page.goto("https://github.com/settings/profile", { waitUntil: "domcontentloaded", timeout: 20000 });
        await sl(2000);
        if (page.url().includes("/settings/")) loggedIn = true;
      } catch {}
    }
    if (!loggedIn) { result.error = "not_logged_in"; await diagSnapshot(page, "07_not_logged"); await browser.close(); return result; }
    log(`  ✓ 登录成功`);

    // §8 PAT
    log(`§8 生成PAT`);
    try {
      await page.goto("https://github.com/settings/tokens/new", { waitUntil: "domcontentloaded", timeout: 30000 });
      await sl(3000);
      const sudoPass = page.locator('input[name="sudo_password"]').first();
      if (await sudoPass.isVisible().catch(() => false)) {
        await sudoPass.fill(pass);
        await page.locator('button[type="submit"]').first().click();
        await sl(3000);
        await page.goto("https://github.com/settings/tokens/new", { waitUntil: "domcontentloaded", timeout: 30000 });
        await sl(2000);
      }
      await page.locator('input[name="oauth_access[description]"], #oauth_access_description').first().fill(`dao-pat-${RUN_ID}`);
      const expSel = page.locator('select[name="oauth_access[expires_in]"], #oauth_access_expires_in').first();
      if (await expSel.isVisible().catch(() => false)) {
        await expSel.selectOption({ value: "none" }).catch(async () => {
          await expSel.selectOption({ label: "No expiration" }).catch(() => {});
        });
      }
      await page.evaluate(() => {
        document.querySelectorAll('input[type="checkbox"][name="oauth_access[scopes][]"]').forEach((c) => { if (!c.checked) c.click(); });
      });
      await sl(1500);
      await page.locator('button[type="submit"]:has-text("Generate")').first().click();
      await sl(5000);
      const pat = await page.locator('#new-oauth-token, [data-test-selector="token"], .token').first().textContent({ timeout: 10000 }).catch(() => null);
      if (pat && pat.startsWith("ghp_")) {
        result.pat = pat.trim();
        log(`  ✓ PAT: ${result.pat.slice(0, 12)}...`);
      } else log(`  ⚠ PAT未获取`);
    } catch (e) { log(`  PAT异常: ${e.message}`); }

    result.ok = true;
    log(`✓✓✓ 账号创建成功 ${user} / ${mail.addr}`);
  } catch (e) {
    log(`异常: ${e.message}`);
    result.error = `exception: ${e.message}`;
    try { await page.screenshot({ path: path.join(OUT_DIR, `fail_${RUN_ID}.png`) }); } catch {}
  }
  await browser.close().catch(() => {});
  return result;
}

(async () => {
  const result = await signup();
  fs.writeFileSync(path.join(OUT_DIR, `account_${RUN_ID}.json`), JSON.stringify(result, null, 2));
  log(`状态: ${result.ok ? "SUCCESS" : "FAIL: " + (result.error || "unknown")}`);
  process.exit(result.ok ? 0 : 1);
})();
