'use strict';

const assert = require('assert');

process.env.OPENCLAW_WEB_UI_MOCK = '1';

const { chromium } = require('playwright');
const { createApp } = require('../server');

async function expectDashboard(page, baseUrl, width, height) {
  await page.setViewportSize({ width, height });
  await page.goto(baseUrl, { waitUntil: 'load' });

  const localAccess = page.locator('#securityStatusCard');
  await localAccess.waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#tab-dashboard').waitFor({ state: 'visible', timeout: 10000 });

  const heading = await localAccess.getByText('Local Access', { exact: true }).count();
  assert.equal(heading, 1, `missing Local Access panel at ${width}x${height}`);

  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const dashboard = document.querySelector('#tab-dashboard');
    const surface = dashboard ? dashboard.scrollWidth - dashboard.clientWidth : 0;
    return {
      pageOverflow: Math.max(0, root.scrollWidth - root.clientWidth),
      surfaceOverflow: Math.max(0, surface)
    };
  });

  assert.equal(
    overflow.pageOverflow,
    0,
    `horizontal page overflow at ${width}x${height}: ${overflow.pageOverflow}px`
  );
  assert.equal(
    overflow.surfaceOverflow,
    0,
    `dashboard overflow at ${width}x${height}: ${overflow.surfaceOverflow}px`
  );
}

async function main() {
  const app = createApp();
  await new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = app.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await expectDashboard(page, baseUrl, 1280, 900);
      await expectDashboard(page, baseUrl, 390, 844);
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }

  console.log('browser-smoke-ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
