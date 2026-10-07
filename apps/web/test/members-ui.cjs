// Headless smoke test of the member features UI (docs/PLAN.md, phase 8).
// Usage: node apps/web/test/members-ui.cjs [BASE_URL] [SHOT_DIR]
//   BASE_URL  API serving the built SPA (WEB_DIST_DIR set), outside production; default http://localhost:3010
//   SHOT_DIR  where to write the PNG screenshots (default: none)
// Creates a throwaway admin (dist/cli/user.js: build apps/api first) to read the dev mail catcher,
// a throwaway member through the API, then drives Chrome.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { withChrome, reporter, sleep } = require('./cdp.cjs');

const BASE = process.argv[2] || 'http://localhost:3010';
const SHOTS = process.argv[3] || '';
const API = `${BASE}/api`;
const rand = Math.random().toString(36).slice(2, 8);

async function api(method, url, { cookie, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (cookie) headers.Cookie = `yomail_session=${cookie}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  const setCookie = res.headers.get('set-cookie') || '';
  const session = /yomail_session=([^;]+)/.exec(setCookie)?.[1] || null;
  return { status: res.status, json, session };
}

/** The dev mail catcher is admin-only: session of the throwaway admin created by makeAdmin(). */
let adminSession = null;

/** Creates an ADMIN with the CLI (same .env as the API) and signs it in. */
async function makeAdmin(username) {
  const email = `${username}@example.test`;
  const password = `correct horse ${username}`;
  execFileSync(
    process.execPath,
    [
      'apps/api/dist/cli/user.js',
      'create-admin',
      '--username',
      username,
      '--email',
      email,
      '--password',
      password,
    ],
    { cwd: path.join(__dirname, '..', '..', '..'), stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const login = await api('POST', '/auth/login', { body: { identifier: username, password } });
  if (login.status !== 200 || !login.session) throw new Error(`admin login ${login.status}`);
  adminSession = login.session;
  return { session: login.session, email, password };
}

/** Sign-up + confirmation through the dev mail catcher; returns { session, email, password }. */
async function makeMember(username) {
  const email = `${username}@example.test`;
  const password = `correct horse ${username}`;
  const signup = await api('POST', '/auth/signup', { body: { username, email, password } });
  if (signup.status !== 201)
    throw new Error(`signup ${signup.status} ${JSON.stringify(signup.json)}`);
  await sleep(800);
  const res = await fetch(`${BASE}/devmailcatcher/messages.json?to=${encodeURIComponent(email)}`, {
    headers: { Cookie: `yomail_session=${adminSession}` },
  });
  if (res.status !== 200) throw new Error(`dev mail catcher ${res.status} (admin session needed)`);
  const messages = await res.json();
  const link = (messages[0]?.links || []).find((u) => u.includes('/confirm/'));
  if (!link) throw new Error(`no confirmation link for ${email}`);
  const token = link.slice(link.lastIndexOf('/') + 1);
  const confirm = await api('POST', '/auth/confirm', { body: { token } });
  if (confirm.status !== 200 || !confirm.session) throw new Error(`confirm ${confirm.status}`);
  return { session: confirm.session, email, password };
}

async function main() {
  const t = reporter();
  const shot = (page, name) => (SHOTS ? page.screenshot(path.join(SHOTS, `${name}.png`)) : null);

  const admin = await makeAdmin(`ui_adm_${rand}`);
  const alice = await makeMember(`ui_alice_${rand}`);
  const bob = await makeMember(`ui_bob_${rand}`);
  const owned = (await api('POST', '/endpoints', { cookie: alice.session })).json;
  await api('PATCH', `/endpoints/${owned.id}`, {
    cookie: alice.session,
    body: { name: 'Payments hook' },
  });
  const anon = (await api('POST', '/endpoints')).json;
  const health = (await api('GET', '/health')).json;
  await fetch(`${BASE}/${owned.id}/orders`, {
    method: 'POST',
    body: '{"a":1}',
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    await withChrome(async (page) => {
      await page.setCookie('yomail_session', alice.session, BASE);

      // Account page: the admin section and its mail catcher button exist for admins only.
      await page.goto(`${BASE}/account`, 2000);
      t.check(
        'account: no admin section for a standard member',
        await page.eval('!document.querySelector("[data-testid=admin-section]")'),
      );
      await page.setCookie('yomail_session', admin.session, BASE);
      await page.goto(`${BASE}/account`, 2000);
      const accountText = await page.text();
      t.check(
        'account: admin sees the Administration section with the mail catcher button',
        accountText.includes('Administration') &&
          (await page.eval(
            'document.querySelector("[data-testid=open-mail-catcher]")?.getAttribute("href")',
          )) === '/devmailcatcher',
        accountText,
      );
      const catcherAsAdmin = await fetch(`${BASE}/devmailcatcher`, {
        headers: { Cookie: `yomail_session=${admin.session}` },
      });
      const catcherAsMember = await fetch(`${BASE}/devmailcatcher`, {
        headers: { Cookie: `yomail_session=${alice.session}` },
      });
      const catcherAnonymous = await fetch(`${BASE}/devmailcatcher`);
      t.check(
        'api: /devmailcatcher is 200 for the admin, 403 for a member, 401 anonymous',
        catcherAsAdmin.status === 200 &&
          catcherAsMember.status === 403 &&
          catcherAnonymous.status === 401,
        `${catcherAsAdmin.status} ${catcherAsMember.status} ${catcherAnonymous.status}`,
      );
      await shot(page, 'account-admin');
      await page.setCookie('yomail_session', alice.session, BASE);

      // Home, signed in: "My endpoints" with the name.
      await page.goto(`${BASE}/`, 2000);
      let text = await page.text();
      t.check('home: header shows the username', text.includes(`ui_alice_${rand}`), text);
      t.check('home: My endpoints section', text.includes('My endpoints'), text);
      t.check(
        'home: owned endpoint listed by name with its count',
        text.includes('Payments hook') && /1 request/.test(text),
        text,
      );
      t.check(
        'home: no "Recent endpoints" title for a member',
        !text.includes('Recent endpoints'),
        text,
      );
      t.check(
        "home: members' retention shown",
        text.includes(`${health.retention_days_members} days`),
        text,
      );
      await shot(page, 'home-member');

      // Inbox as owner: name, Yours badge, Edit -> rename.
      await page.goto(`${BASE}/inbox/${owned.id}`, 2500);
      text = await page.text();
      t.check(
        'inbox: name shown as title',
        (await page.eval('document.querySelector("[data-testid=endpoint-name]")?.textContent')) ===
          'Payments hook',
      );
      t.check(
        'inbox: Yours badge',
        (await page.eval('document.querySelector("[data-testid=owner-badge]")?.textContent')) ===
          'Yours',
      );
      t.check(
        'inbox: Edit button for the owner',
        await page.eval('!!document.querySelector("[data-testid=edit-endpoint]")'),
      );
      t.check(
        'inbox: no Claim button on an owned endpoint',
        await page.eval('!document.querySelector("[data-testid=claim-endpoint]")'),
      );
      t.check(
        'inbox: Delete endpoint visible to the owner',
        await page.eval('!!document.querySelector("[data-testid=delete-endpoint]")'),
      );
      const limits = await page.eval(
        'document.querySelector("[data-testid=endpoint-limits]")?.textContent',
      );
      t.check(
        "inbox: members' limits shown on an owned endpoint",
        typeof limits === 'string' &&
          limits.includes(`${health.retention_days_members} days`) &&
          limits.includes(
            `${health.max_requests_per_endpoint_members.toLocaleString()} per endpoint`,
          ) &&
          limits.includes('member limits'),
        limits,
      );
      await page.click('[data-testid=edit-endpoint]');
      t.check(
        'inbox: settings panel opens',
        await page.eval('!!document.querySelector("[data-testid=endpoint-settings]")'),
      );
      await page.type('#endpoint-name', 'Payments hook v2');
      await page.eval('document.querySelector("#endpoint-name").form.requestSubmit()');
      await sleep(1200);
      t.check(
        'inbox: title updates after rename',
        (await page.eval('document.querySelector("[data-testid=endpoint-name]")?.textContent')) ===
          'Payments hook v2',
      );
      t.check(
        'inbox: document.title follows the name',
        (await page.eval('document.title')).startsWith('Payments hook v2'),
      );
      await shot(page, 'inbox-owner-settings');
      const detail = await api('GET', `/endpoints/${owned.id}`, { cookie: alice.session });
      t.check(
        'api: name persisted',
        detail.json?.name === 'Payments hook v2',
        JSON.stringify(detail.json),
      );

      // Response form (8.2): configure, see the badge, hit the URL, reset.
      t.check(
        'response: form present in settings',
        await page.eval('!!document.querySelector("#response-status")'),
      );
      t.check(
        'response: no Reset button while default',
        await page.eval('!document.querySelector("[data-testid=reset-response]")'),
      );
      await page.type('#response-status', '418');
      await page.type('#response-content-type', 'text/plain');
      await page.type('#response-body', 'short and stout');
      await page.eval('document.querySelector("#response-status").form.requestSubmit()');
      await sleep(1200);
      text = await page.text();
      t.check('response: saved notice', text.includes('Custom response saved.'), text);
      t.check(
        'response: badge in the header',
        await page.eval('!!document.querySelector("[data-testid=custom-response-badge]")'),
      );
      const hit = await fetch(`${BASE}/${owned.id}/teapot`, { method: 'POST', body: 'x' });
      t.check(
        'response: URL answers the configured status and body',
        hit.status === 418 && (await hit.text()) === 'short and stout',
        hit.status,
      );
      t.check(
        'response: sandboxed in browsers',
        hit.headers.get('content-security-policy') === 'sandbox',
      );
      await shot(page, 'inbox-owner-response');
      await page.click('[data-testid=reset-response]', 1200);
      t.check(
        'response: badge gone after reset',
        await page.eval('!document.querySelector("[data-testid=custom-response-badge]")'),
      );
      const hit2 = await fetch(`${BASE}/${owned.id}`, { method: 'POST', body: 'x' });
      t.check('response: default restored', hit2.status === 200 && (await hit2.json()).ok === true);

      // 8.3: filter, Copy as cURL, note, replay.
      await fetch(`${BASE}/${owned.id}/second?x=2`, {
        method: 'PUT',
        body: 'two',
        headers: { 'Content-Type': 'text/plain' },
      });
      await sleep(1500);
      text = await page.text();
      t.check(
        'filter: bar shown to a member',
        await page.eval('!!document.querySelector("[data-testid=request-filter]")'),
      );
      await page.type('[data-testid=request-filter] input', 'orders');
      await sleep(400);
      text = await page.text();
      t.check(
        'filter: list reduced to the matching request',
        /1 of \d+/i.test(text) &&
          text.includes('/orders') &&
          !text.split('\n').some((l) => l.trim() === '/second'),
        text,
      );
      await page.type('[data-testid=request-filter] input', 'nothing-matches');
      await sleep(400);
      t.check(
        'filter: empty state',
        await page.eval('!!document.querySelector("[data-testid=filter-empty]")'),
      );
      await page.click('[aria-label="Clear filter"]');
      text = await page.text();
      t.check('filter: cleared', /inbox \(\d+\)/i.test(text) && !/ of \d+\)/.test(text), text);

      await page.eval(
        'window.__copied = null; navigator.clipboard.writeText = (v) => { window.__copied = v; return Promise.resolve(); }; true',
      );
      await page.goto(`${BASE}/inbox/${owned.id}`, 2000);
      await page.eval(
        'window.__copied = null; navigator.clipboard.writeText = (v) => { window.__copied = v; return Promise.resolve(); }; true',
      );
      const curlButton = await page.eval(
        '[...document.querySelectorAll("button")].some(b => b.textContent === "Copy as cURL")',
      );
      t.check('curl: button shown to a member', curlButton);
      await page.eval(
        '[...document.querySelectorAll("button")].find(b => b.textContent === "Copy as cURL").click()',
      );
      await sleep(300);
      const curl = await page.eval('window.__copied');
      t.check(
        'curl: command copied with method, URL and header',
        typeof curl === 'string' &&
          curl.startsWith('curl -X PUT') &&
          curl.includes(`/${owned.id}/second?x=2`) &&
          /-H 'content-type: text\/plain'/i.test(curl) &&
          curl.includes("--data-binary 'two'") &&
          !/-H 'host:/i.test(curl),
        curl,
      );
      const before = (
        await api('GET', `/endpoints/${owned.id}/requests`, { cookie: alice.session })
      ).json.requests.length;
      execFileSync('bash', ['-c', curl + ' -s -o /dev/null'], { stdio: 'ignore' });
      await sleep(500);
      const after = (await api('GET', `/endpoints/${owned.id}/requests`, { cookie: alice.session }))
        .json;
      t.check(
        'curl: replaying the copied command captures an identical request',
        after.requests.length === before + 1 &&
          after.requests[0].method === 'PUT' &&
          after.requests[0].path === '/second',
        JSON.stringify(after.requests[0]),
      );

      // Pin the selection on the newest request so live arrivals cannot move the panel while typing.
      await page.goto(`${BASE}/inbox/${owned.id}/${after.requests[0].id}`, 2500);
      await page.type('[data-testid=note-input]', 'Replayed by hand');
      await page.click('[data-testid=note-save]', 1200);
      text = await page.text();
      t.check('note: saved notice', text.includes('Saved.'), text);
      await page.goto(`${BASE}/inbox/${owned.id}`, 2500);
      t.check(
        'note: visible after reload',
        (await page.eval('document.querySelector("[data-testid=note-input]")?.value')) ===
          'Replayed by hand',
      );

      if (process.env.REPLAY_PRIVATE_OK === '1') {
        const sink = (await api('POST', '/endpoints')).json;
        await page.eval(
          '[...document.querySelectorAll("button[aria-expanded]")].find(b => b.textContent.includes("Replay")).click()',
        );
        await sleep(300);
        await page.type('[data-testid=replay-target]', `${BASE}/${sink.id}/from-ui`);
        await page.click('[data-testid=replay-send]', 2500);
        t.check(
          'replay: result shown with the target status',
          await page.eval(
            'document.querySelector("[data-testid=replay-result]")?.textContent.includes("200")',
          ),
        );
        const sunk = (await api('GET', `/endpoints/${sink.id}/requests`)).json;
        t.check(
          'replay: request arrived at the target',
          sunk.requests.length === 1 && sunk.requests[0].path === '/from-ui',
          JSON.stringify(sunk),
        );
        await shot(page, 'inbox-owner-replay');
        await api('DELETE', `/endpoints/${sink.id}`);
      } else {
        console.log(
          'SKIP  replay UI (set REPLAY_PRIVATE_OK=1 with an API started with REPLAY_ALLOW_PRIVATE=1)',
        );
      }

      // Inbox of an ownerless endpoint as a member: Claim.
      await page.goto(`${BASE}/inbox/${anon.id}`, 2500);
      t.check(
        'claim: button shown on an ownerless endpoint',
        await page.eval('!!document.querySelector("[data-testid=claim-endpoint]")'),
      );
      t.check(
        'claim: no badge before claiming',
        await page.eval('!document.querySelector("[data-testid=owner-badge]")'),
      );
      await page.click('[data-testid=claim-endpoint]', 1500);
      t.check(
        'claim: Yours badge after claiming',
        (await page.eval('document.querySelector("[data-testid=owner-badge]")?.textContent')) ===
          'Yours',
      );
      t.check(
        'claim: Edit appears after claiming',
        await page.eval('!!document.querySelector("[data-testid=edit-endpoint]")'),
      );
      const mine = await api('GET', '/account/endpoints', { cookie: alice.session });
      t.check(
        'api: claimed endpoint in My endpoints',
        mine.json?.endpoints.some((e) => e.id === anon.id),
        JSON.stringify(mine.json),
      );

      // Owned endpoints are private (phase 8): anonymous visitor -> "private" page with Sign in.
      await page.clearCookies();
      await page.goto(`${BASE}/inbox/${owned.id}`, 2500);
      text = await page.text();
      t.check(
        'anonymous: private endpoint page',
        (await page.eval('!!document.querySelector("[data-testid=private-endpoint]")')) &&
          text.includes('This endpoint is private') &&
          text.includes('Sign in as its owner'),
        text,
      );
      t.check(
        'anonymous: Sign in link goes to /login with next=',
        (await page.eval(
          'document.querySelector("[data-testid=private-sign-in]")?.getAttribute("href")',
        )) === `/login?next=${encodeURIComponent(`/inbox/${owned.id}`)}`,
      );
      t.check(
        'anonymous: nothing of the inbox leaks (no request, no name, no note, no badge)',
        !text.includes('/orders') &&
          !text.includes('Payments hook v2') &&
          !text.includes('Replayed by hand') &&
          (await page.eval('!document.querySelector("[data-testid=owner-badge]")')),
        text,
      );
      t.check(
        'anonymous: no Delete, Edit, Claim or Clear button',
        await page.eval(
          '!document.querySelector("[data-testid=delete-endpoint]") && !document.querySelector("[data-testid=edit-endpoint]") && !document.querySelector("[data-testid=claim-endpoint]") && ![...document.querySelectorAll("button")].some(b => b.textContent === "Clear inbox")',
        ),
      );
      const anonList = await api('GET', `/endpoints/${owned.id}/requests`);
      t.check(
        'api: anonymous list of an owned endpoint -> 401',
        anonList.status === 401,
        anonList.status,
      );

      // Another member: private page without Sign in.
      await page.setCookie('yomail_session', bob.session, BASE);
      await page.goto(`${BASE}/inbox/${owned.id}`, 2500);
      text = await page.text();
      t.check(
        'other member: private endpoint page ("another member")',
        (await page.eval('!!document.querySelector("[data-testid=private-endpoint]")')) &&
          text.includes('another member') &&
          (await page.eval('!document.querySelector("[data-testid=private-sign-in]")')),
        text,
      );
      t.check(
        'other member: nothing of the inbox leaks',
        !text.includes('/orders') && !text.includes('Payments hook v2'),
        text,
      );
      const bobList = await api('GET', `/endpoints/${owned.id}/requests`, { cookie: bob.session });
      t.check(
        'api: other member list of an owned endpoint -> 403 NOT_OWNER',
        bobList.status === 403 && bobList.json?.code === 'NOT_OWNER',
        JSON.stringify(bobList.json),
      );
      await page.clearCookies();
      await shot(page, 'inbox-anonymous-owned');

      // Anonymous home on mobile: unchanged (no My endpoints, sign-up hint).
      await page.mobile(true);
      await page.goto(`${BASE}/`, 1500);
      text = await page.text();
      t.check('anonymous home: no My endpoints', !text.includes('My endpoints'), text);
      t.check('anonymous home: account hint', text.includes('Create a free account'), text);
      t.check(
        'anonymous home: base retention shown',
        text.includes(`${health.retention_days} days`) &&
          !text.includes(`${health.retention_days_members} days`),
        text,
      );
      await shot(page, 'home-anonymous-mobile');
      await page.mobile(false);
    });
  } finally {
    await api('DELETE', `/endpoints/${owned.id}`, { cookie: alice.session });
    await api('DELETE', `/endpoints/${anon.id}`, { cookie: alice.session });
    await api('DELETE', '/account', { cookie: alice.session, body: { password: alice.password } });
    await api('DELETE', '/account', { cookie: bob.session, body: { password: bob.password } });
    await api('DELETE', '/account', { cookie: admin.session, body: { password: admin.password } });
  }
  t.done();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
