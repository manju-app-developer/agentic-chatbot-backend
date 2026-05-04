const { chromium } = require('playwright');

const CDP_URL = 'http://localhost:9222';

class AgentBrowser {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isCDP = false;
  }

  async init() {
    if (this.browser) return;
    
    // First, try to connect to an existing Chrome instance via CDP
    try {
      this.browser = await chromium.connectOverCDP(CDP_URL);
      this.isCDP = true;
      console.log('[Browser] Connected to existing Chrome via CDP.');
      
      // Use the first existing context (your logged-in profile)
      const contexts = this.browser.contexts();
      const context = contexts[0] || await this.browser.newContext();
      
      // Reuse an existing blank tab if one exists, otherwise open a new one
      const pages = context.pages();
      const blankPage = pages.find(p => p.url() === 'about:blank' || p.url() === 'chrome://new-tab-page/');
      if (blankPage) {
        this.page = blankPage;
        console.log('[Browser] Reusing existing blank tab.');
      } else {
        this.page = await context.newPage();
        console.log('[Browser] Opened a new tab in your Chrome.');
      }
    } catch (err) {
      // Fallback: launch a fresh browser if CDP fails
      console.warn('[Browser] Could not connect to Chrome via CDP. Launching fresh browser. Error:', err.message);
      this.isCDP = false;
      
      const { chromium: chromiumExtra } = require('playwright-extra');
      const stealth = require('puppeteer-extra-plugin-stealth')();
      chromiumExtra.use(stealth);
      
      this.browser = await chromiumExtra.launch({ headless: false });
      const context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      });
      this.page = await context.newPage();
    }
  }

  async ensureInit() {
    if (!this.browser || !this.page) {
      await this.init();
    }
  }

  async goto(url) {
    await this.ensureInit();
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async look() {
    // If not initialized, return empty summary
    if (!this.browser || !this.page) return "No browser open.";
    
    const elementsSummary = await this.page.evaluate(() => {
      let idCounter = 1;
      const elements = [];
      const interactables = document.querySelectorAll('button, input, select, textarea, a');
      
      interactables.forEach((el) => {
        if (el.offsetParent === null) return;
        
        const tagName = el.tagName.toLowerCase();
        let name = el.innerText || el.value || el.placeholder || el.name || '';
        name = name.trim().replace(/\n/g, ' ').substring(0, 50);
        
        if (!name && tagName === 'input') {
          name = el.type;
        }

        if (!name && el.getAttribute('aria-label')) {
          name = el.getAttribute('aria-label');
        }

        if (tagName === 'a' && !name) {
          name = el.href.substring(0, 30);
        }

        el.setAttribute('data-ai-id', idCounter);
        elements.push(`[${idCounter}] ${tagName}: '${name}'`);
        idCounter++;
      });
      
      return elements.join('\n');
    });
    
    return elementsSummary;
  }

  async click(id) {
    await this.ensureInit();
    const selector = `[data-ai-id="${id}"]`;
    await this.page.waitForSelector(selector, { timeout: 10000 });
    await this.page.click(selector, { force: true });
    await this.page.waitForTimeout(2000);
  }

  async type(id, text) {
    await this.ensureInit();
    const selector = `[data-ai-id="${id}"]`;
    await this.page.waitForSelector(selector, { timeout: 5000 });
    await this.page.fill(selector, text);
  }

  async press(key) {
    await this.ensureInit();
    await this.page.keyboard.press(key);
    await this.page.waitForTimeout(1000);
  }

  async keyboard_type(text) {
    await this.ensureInit();
    await this.page.keyboard.type(text, { delay: 50 });
    await this.page.waitForTimeout(500);
  }

  async skipYouTubeAd() {
    if (!this.page) return false;
    try {
      // Try clicking 'Skip Ad' button if it exists
      const skipButton = await this.page.$('.ytp-skip-ad-button, .ytp-ad-skip-button, button.ytp-skip-ad-button');
      if (skipButton) {
        await skipButton.click();
        await this.page.waitForTimeout(1000);
        return true;
      }
    } catch (e) {}
    return false;
  }

  async getPageText() {
    return await this.page.evaluate(() => document.body.innerText.substring(0, 2000));
  }

  async close() {
    // If connected via CDP, just close the page (tab), not the whole browser
    if (this.page) {
      try { await this.page.close(); } catch (e) {}
      this.page = null;
    }
    // Only close the browser if we launched it ourselves
    if (this.browser && !this.isCDP) {
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
    }
  }
}

module.exports = AgentBrowser;
