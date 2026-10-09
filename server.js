/* CapCut Trial Activator — Render.com microservice
 * 
 * Uses Puppeteer (headless Chrome) to execute CapCut's browser-side JavaScript
 * that activates the 7-day Pro trial. API calls alone can't do this because
 * CapCut requires JavaScript execution for trial activation.
 *
 * POST /activate { cookie, userId } → opens browser, sets cookies, navigates to
 * fission_receive URL, calls trial endpoints from browser context → returns result
 *
 * Setup:
 *   1. Deploy this folder to Render.com as a Web Service
 *   2. Set env var: API_KEY=<random-string>
 *   3. Set env var: PORT=3000 (Render auto-assigns, but good to have)
 *   4. Your Vercel app calls this service's URL
 */

const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY || 'changeme';
const AID = '348188';

// Auth check
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (token !== API_KEY) return res.status(403).json({ ok: false, error: 'unauthorized' });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.post('/activate', async (req, res) => {
  const { cookie, userId } = req.body || {};
  if (!cookie || !userId) {
    return res.status(400).json({ ok: false, error: 'cookie + userId wajib' });
  }

  let browser;
  try {
    console.log(`[activate] Starting for userId=${userId}`);
    
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',  // disable CORS so page.evaluate fetch calls work
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      headless: 'new',
      timeout: 45000,
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Set CapCut cookies from registration
    const cookies = cookie.split('; ').filter(Boolean).map(c => {
      const idx = c.indexOf('=');
      const name = c.slice(0, idx).trim();
      const value = c.slice(idx + 1).trim();
      return { name, value, domain: '.capcut.com', path: '/' };
    });
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log(`[activate] Set ${cookies.length} cookies`);
    }

    // Step 1: Navigate to fission_receive page (triggers trial JavaScript)
    const fissionUrl = `https://www.capcut.com/capcut_pc_web/fission_receive?enter_from=share&user_id=${userId}&lng=en`;
    console.log('[activate] Navigating to:', fissionUrl);
    
    try {
      await page.goto(fissionUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      console.log('[activate] Page loaded, waiting for JS...');
    } catch (e) {
      console.log('[activate] Navigation error (continuing):', e.message);
    }

    // Wait for JavaScript to execute
    await new Promise(r => setTimeout(r, 5000));

    // Step 2: Also explicitly call trial endpoints from browser context
    // (cookies are automatically sent because we're on capcut.com domain)
    console.log('[activate] Calling trial endpoints via browser...');
    
    const trialResult = await page.evaluate(async (aid, uid) => {
      const results = {};

      // is_activity_valid
      try {
        const r = await fetch('https://feed-api-sg.capcut.com/lv/v1/pc/share/is_activity_valid', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        results.is_activity_valid = await r.json();
      } catch (e) { results.is_activity_valid = { error: e.message }; }

      // token_gen
      let token = null;
      try {
        const r = await fetch('https://feed-api-sg.capcut.com/lv/v1/pc/share/token_gen', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        const j = await r.json();
        if (j && j.data && j.data.token) token = j.data.token;
        results.token_gen = j;
      } catch (e) { results.token_gen = { error: e.message }; }

      // start_activation
      try {
        const r = await fetch('https://commerce-api-sg.capcut.com/commerce/v1/vip/outside/start_activation', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ aid: Number(aid), scene: 'vip' })
        });
        results.start_activation = await r.json();
      } catch (e) { results.start_activation = { error: e.message }; }

      // coldstart_popup
      try {
        const r = await fetch(`https://commerce-api-sg.capcut.com/luckycat/i18n/capcut/campaign/v1/coldstart_popup?scene=web&entrance=&aid=${aid}`);
        results.coldstart = await r.json();
      } catch (e) { results.coldstart = { error: e.message }; }

      // mur101/redeem_reward (self-referral)
      try {
        const r = await fetch('https://commerce-api-sg.capcut.com/luckycat/i18n/capcut/campaign/v1/mur101/redeem_reward', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inviter_uid: uid, user_id: uid, invite_code: token || uid })
        });
        results.redeem = await r.json();
      } catch (e) { results.redeem = { error: e.message }; }

      // free_trial_make_order — THE KEY STEP
      try {
        const r = await fetch('https://commerce-api-sg.capcut.com/pipo/v2/subscription/third_party/free_trial_make_order', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ aid: Number(aid), region: 'SG', user_create_time: Math.floor(Date.now() / 1000), payment_method: 'free_trial' })
        });
        results.free_trial = await r.json();
      } catch (e) { results.free_trial = { error: e.message }; }

      // get_user_rights
      try {
        const r = await fetch('https://feed-api-sg.capcut.com/lv/v1/pc/share/get_user_rights', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        results.rights = await r.json();
      } catch (e) { results.rights = { error: e.message }; }

      // subscription_user_info (check if Pro is active)
      try {
        const r = await fetch(`https://commerce-api-sg.capcut.com/commerce/v1/subscription/user_info?aid=${aid}`);
        results.subscription = await r.json();
      } catch (e) { results.subscription = { error: e.message }; }

      return results;
    }, AID, userId);

    console.log('[activate] Trial results:', JSON.stringify(trialResult).slice(0, 200));
    
    await browser.close();
    browser = null;

    // Check if trial was activated
    const success = Object.values(trialResult).some(v => {
      if (!v) return false;
      if (v.ret === '0') return true;
      if (v.err_no === 0) return true;
      return false;
    });

    console.log(`[activate] Done. Success: ${success}`);
    return res.json({ ok: true, success, trialResult });

  } catch (e) {
    console.error('[activate] Error:', e.message);
    if (browser) {
      try { await browser.close(); } catch {}
    }
    return res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CapCut Trial Activator running on port ${PORT}`);
  console.log(`API_KEY: ${API_KEY === 'changeme' ? 'WARNING: using default key!' : 'set'}`);
});
