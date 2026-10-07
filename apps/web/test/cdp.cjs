// Minimal Chrome DevTools Protocol driver for the headless smoke tests (no browser tool
// needed). `--dump-dom` cannot be used on the inbox page: the pending Socket.IO long-poll
// keeps virtual time from advancing. Usage from a scenario script:
//
//   const { withChrome } = require('./cdp.cjs');
//   await withChrome(async (page) => { await page.goto(url); ... });
//
// Env: CHROME (path to chrome.exe), CDP_PORT (default 9333).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME =
  process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9333);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async goto(url, settleMs = 1500) {
    await this.send('Page.navigate', { url });
    await sleep(settleMs);
  }

  /** Evaluates an expression in the page and returns its JSON value (awaits promises). */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    }
    return r.result.value;
  }

  text() {
    return this.eval('document.body.innerText');
  }

  /** Clicks the first element matching the selector (throws when absent). */
  async click(selector, settleMs = 500) {
    const found = await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
    );
    if (!found) throw new Error(`no element for ${selector}`);
    await sleep(settleMs);
  }

  /** Sets a controlled React input's value (native setter + input event). */
  async type(selector, value) {
    const found = await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
    );
    if (!found) throw new Error(`no element for ${selector}`);
  }

  async setCookie(name, value, url) {
    const r = await this.send('Network.setCookie', { name, value, url, httpOnly: true, path: '/' });
    if (!r.success) throw new Error(`could not set cookie ${name}`);
  }

  clearCookies() {
    return this.send('Network.clearBrowserCookies');
  }

  async mobile(on = true) {
    if (on) {
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
      });
    } else {
      await this.send('Emulation.clearDeviceMetricsOverride');
    }
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
}

async function withChrome(fn) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yomail-cdp-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1400,1000',
      '--no-first-run',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    let targets = null;
    for (let i = 0; i < 50 && !targets; i++) {
      await sleep(200);
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json`);
        targets = await res.json();
      } catch {
        /* not ready yet */
      }
    }
    if (!targets) throw new Error('Chrome did not expose the DevTools endpoint');
    const target = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    const page = new Page(ws);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    try {
      return await fn(page);
    } finally {
      ws.close();
    }
  } finally {
    chrome.kill();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/** Tiny PASS/FAIL reporter shared by the scenarios. */
function reporter() {
  let failed = 0;
  return {
    check(name, cond, detail = '') {
      if (cond) console.log(`PASS  ${name}`);
      else {
        failed++;
        console.log(`FAIL  ${name}${detail ? ` (${String(detail).slice(0, 300)})` : ''}`);
      }
    },
    done() {
      console.log(failed === 0 ? 'ALL PASS' : 'SOME FAILED');
      process.exitCode = failed === 0 ? 0 : 1;
    },
  };
}

module.exports = { withChrome, reporter, sleep };
