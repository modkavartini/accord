// Headed login using the SAME Playwright launch the service uses (which is
// known to reach Google), so the sign-in page actually loads. Runs on the
// Xvfb display that noVNC is showing; stays open until killed.
const { chromium } = require('playwright-core');
const PROFILE_DIR = process.env.PROFILE_DIR || `${process.env.HOME}/accord-reader/profile`;
const CHROMIUM    = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: CHROMIUM,
    viewport: null,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--start-maximized', '--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  try { await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) {}
  console.log('[login] browser ready — sign in via noVNC');
  await new Promise(() => {});   // stay open
})();
