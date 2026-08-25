const { chromium } = require('D:/vale-agent/playwright/node_modules/playwright-core');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; const frameReqs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0,120)); });
  page.on('response', r => { if (r.url().includes('/api/browser/frame')) frameReqs.push(r.status()); });
  await page.goto('https://d1.agent.saisi.online/panel/', { waitUntil: 'networkidle' });
  await page.locator('input').nth(0).fill('d1.agent.saisi.online');
  await page.locator('input').nth(1).fill('58a147d14e6feda71e227725d00dcef5c42339ffa7a30c95dddb1a3de0b616b1');
  await page.locator('button', { hasText: 'Connect' }).click();
  await page.waitForTimeout(2500);
  await page.locator('text=Browser now').click();
  await page.waitForTimeout(8000);
  const img = page.locator('#term-container img').first();
  const cnt = await img.count();
  let info = 'no-img';
  if (cnt > 0) {
    info = JSON.stringify({ complete: await img.evaluate(el => el.complete), nw: await img.evaluate(el => el.naturalWidth), srcHead: (await img.getAttribute('src') || '').slice(0, 30) });
    const b64 = await img.screenshot({ type: 'png' }).then(b => b.toString('base64'));
    require('fs').writeFileSync('D:/vale-agent/pane.png', Buffer.from(b64, 'base64'));
  }
  console.log('img-count:', cnt, '| img:', info);
  console.log('frame-reqs:', JSON.stringify(frameReqs.slice(-8)));
  console.log('errors:', JSON.stringify(errs.slice(0, 5)));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
