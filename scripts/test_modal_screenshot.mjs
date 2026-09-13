import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('http://localhost:3008/?project=placemakers&t=123456', { waitUntil: 'networkidle' });
  await page.fill('input[type="text"]', 'admin');
  await page.fill('input[type="password"]', 'admin');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);

  const perfBtn = await page.$('button[aria-label="Model Speed & Performance"]');
  if (perfBtn) {
    await perfBtn.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: '/Users/mahaveer/.gemini/antigravity-ide/brain/e2f0b873-5e44-42fd-b927-0b7892e26d08/ui_screen_13_speed_performance_modal.png' });
    console.log('✅ Speed & Performance modal screenshot captured successfully!');
  } else {
    console.error('Could not find perfBtn');
  }
  await browser.close();
})().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
