const fs = require('fs');
const https = require('https');
const { GoogleGenAI } = require('@google/genai');
const path = require('path');

class CaptchaSolver {
  constructor(apiKey) {
    this.ai = new GoogleGenAI({ apiKey: apiKey });
  }

  async downloadAudio(url, dest) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      https.get(url, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close(resolve);
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    });
  }

  async solveReCaptcha(page, emitUpdate) {
    try {
      emitUpdate("Detecting reCAPTCHA iframe...");
      
      // Wait for reCAPTCHA iframe
      const recaptchaFrameElement = await page.waitForSelector('iframe[title="reCAPTCHA"]', { timeout: 5000 }).catch(() => null);
      if (!recaptchaFrameElement) {
         emitUpdate("No reCAPTCHA found.");
         return false;
      }

      emitUpdate("Clicking 'I am not a robot'...");
      const recaptchaFrame = await recaptchaFrameElement.contentFrame();
      await recaptchaFrame.click('.recaptcha-checkbox-border');
      await page.waitForTimeout(2000); // Wait for challenge to appear

      emitUpdate("Looking for challenge iframe...");
      const bframeElement = await page.waitForSelector('iframe[title*="recaptcha challenge"]', { timeout: 5000 });
      const bframe = await bframeElement.contentFrame();

      emitUpdate("Clicking audio challenge button...");
      await bframe.waitForSelector('#recaptcha-audio-button', { timeout: 5000 });
      await bframe.click('#recaptcha-audio-button');
      await page.waitForTimeout(1000);

      emitUpdate("Extracting audio URL...");
      await bframe.waitForSelector('.rc-audiochallenge-tdownload-link', { timeout: 5000 });
      const audioUrl = await bframe.$eval('.rc-audiochallenge-tdownload-link', el => el.href);
      
      const audioPath = path.join(__dirname, 'captcha.mp3');
      emitUpdate("Downloading audio file...");
      await this.downloadAudio(audioUrl, audioPath);

      emitUpdate("Transcribing with Gemini 2.5 Flash...");
      const audioData = fs.readFileSync(audioPath);
      const base64Audio = audioData.toString('base64');
      
      const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
            { text: "Listen to this audio and write down the numbers spoken. ONLY output the numbers, nothing else." },
            { inlineData: { data: base64Audio, mimeType: "audio/mp3" } }
        ]
      });
      
      const answer = response.text.trim().replace(/[^0-9]/g, '');
      emitUpdate(`Transcription received: ${answer}`);

      emitUpdate("Typing response and submitting...");
      await bframe.type('#audio-response', answer);
      await bframe.click('#recaptcha-verify-button');
      await page.waitForTimeout(2000);
      
      // Clean up file
      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }
      
      emitUpdate("CAPTCHA bypass complete!");
      return true;
    } catch (err) {
      console.error(err);
      emitUpdate(`CAPTCHA Bypass Error: ${err.message}`);
      return false;
    }
  }
}

module.exports = CaptchaSolver;
