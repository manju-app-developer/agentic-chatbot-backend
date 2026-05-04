const { GoogleGenAI } = require('@google/genai');
const CaptchaSolver = require('./captcha');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class AIAgent {
  constructor(apiKeys, emitUpdate, askHuman, askHumanStepApproval) {
    this.apiKeys = apiKeys;
    this.currentKeyIndex = 0;
    this.emitUpdate = emitUpdate;
    this.askHuman = askHuman;
    this.askHumanStepApproval = askHumanStepApproval;
    this.isCancelled = false;
  }

  get ai() {
    return new GoogleGenAI({ apiKey: this.apiKeys[this.currentKeyIndex] });
  }

  abort() {
    this.isCancelled = true;
  }

  async processStep(task, currentUrl, screenSummary) {
    const prompt = `
You are an AI Agent operating a web browser to complete a user task.
User Task: "${task}"

Current URL: ${currentUrl}

Elements currently on the screen:
${screenSummary ? screenSummary : 'No interactive elements found.'}

Decide your next action to progress towards the goal. You can only perform one action at a time.
CRITICAL INSTRUCTION: If the task requires specific details that the user did not provide (e.g., travel dates, specific times, exact names, or passwords), you MUST use the "ask_human" action to request this information BEFORE guessing, clicking search, or proceeding with default values.
GOOGLE SIGN-IN HANDLING: If you see a Google account picker page (with email addresses listed), click directly on the listed email account to sign in. Do NOT click "Use another account" or try to type a new email. If you are on a sign-in page and see the user's email already listed, just click it. If you have been stuck on login/sign-in pages for more than 2 steps without progress, use "ask_human" to ask the user to complete the sign-in manually.
TASK COMPLETION: As soon as the primary goal is achieved, you MUST immediately return action "done". Examples: if the task was to play a YouTube video and you can see the video player is now active/playing — return done. If you sent an email successfully — return done. Do NOT keep clicking or navigating after the goal is reached.
If you need to change system settings (like brightness, volume, opening apps), use "run_system_command".
If you encounter a login screen, an unpassable CAPTCHA, or need user information, use the "ask_human" action.
TIP FOR GOOGLE SHEETS/DOCS: Standard 'click' and 'type' often fail because the canvas hides elements. Instead, use 'click' once on the general area, then use 'keyboard_type' and 'press_key' (e.g., Tab, Enter, ArrowDown) to navigate and enter data blindly.
Respond ONLY with a valid JSON object matching this schema, with no markdown formatting or extra text:
{
  "action": "goto" | "click" | "type" | "keyboard_type" | "press_key" | "wait" | "solve_captcha" | "ask_human" | "run_system_command" | "done",
  "url": "URL to navigate to (if action is goto)",
  "elementId": 123, // ID of the element to interact with (if click or type)
  "value": "text to type (if action is type or keyboard_type)",
  "key": "key to press (if action is press_key, e.g. 'Enter', 'Tab', 'ArrowDown')",
  "question": "what you need the human to do (if action is ask_human)",
  "command": "the terminal command to run (if action is run_system_command). Powershell is allowed.",
  "reason": "a short explanation of why you are taking this action"
}
`;

    const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    let attempts = 0;
    const maxAttempts = this.apiKeys.length * 2; // Try each key up to 2 times

    while (attempts < maxAttempts) {
      const keyNum = this.currentKeyIndex + 1;
      this.emitUpdate(`Using API Key ${keyNum}/${this.apiKeys.length} (${MODEL})...`, 'info');
      try {
        const response = await this.ai.models.generateContent({
          model: MODEL,
          contents: prompt,
          config: {
            responseMimeType: "application/json"
          }
        });

        const responseText = response.text;
        const parsed = JSON.parse(responseText);
        this.emitUpdate(`Brain thought: ${parsed.reason}`, 'thought');
        return parsed;
      } catch (error) {
        const status = error.status || error?.error?.code || 'unknown';
        const is429 = status === 429 || String(status) === '429';
        // Backoff: 10s for 429 rate limit, 2s for other errors
        const waitMs = is429 ? 10000 : 2000;
        this.emitUpdate(`Key ${keyNum} error (${status}). Waiting ${waitMs / 1000}s then switching...`, 'error');
        console.error(`AI Error [Key ${keyNum}]:`, error.message || error);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
        attempts++;
      }
    }

    this.emitUpdate(`All ${this.apiKeys.length} API keys rate-limited. Try again in a minute.`, 'error');
    return { action: "done", reason: "All API keys exhausted." };
  }

  async runLoop(browser, task, maxSteps = 15) {
    this.isCancelled = false;

    // Initialize browser upfront — fail fast with a visible error if Playwright can't launch
    try {
      this.emitUpdate('Launching browser...', 'info');
      await browser.ensureInit();
      this.emitUpdate('Browser ready.', 'info');
    } catch (initErr) {
      this.emitUpdate(`❌ Browser failed to launch: ${initErr.message}`, 'error');
      this.emitUpdate('Cannot proceed without a browser. Task aborted.', 'error');
      return;
    }

    let steps = 0;
    while (steps < maxSteps && !this.isCancelled) {
      if (this.isCancelled) break;
      this.emitUpdate("Looking at screen...", 'info');

      // Auto-skip YouTube ads before AI processes the screen
      if (browser.page) {
        const currentUrl = browser.page.url();
        if (currentUrl.includes('youtube.com')) {
          const skipped = await browser.skipYouTubeAd();
          if (skipped) this.emitUpdate('Skipped YouTube ad.', 'info');
        }
      }

      const screenSummary = await browser.look();
      const currentUrl = browser.page ? browser.page.url() : "No browser open.";

      if (this.isCancelled) break;
      this.emitUpdate("Thinking about next action...", 'info');
      const instruction = await this.processStep(task, currentUrl, screenSummary);

      if (this.isCancelled) break;
      if (instruction.action === 'done') {
        this.emitUpdate("Task marked as completed by AI.", 'info');
        break;
      }

      try {
        if (instruction.action === 'goto') {
          this.emitUpdate(`Navigating to ${instruction.url}...`);
          await browser.goto(instruction.url);
        } else if (instruction.action === 'click') {
          this.emitUpdate(`Clicking element ID ${instruction.elementId}...`);
          await browser.click(instruction.elementId);
        } else if (instruction.action === 'type') {
          this.emitUpdate(`Typing "${instruction.value}" into element ID ${instruction.elementId}...`);
          await browser.type(instruction.elementId, instruction.value);
        } else if (instruction.action === 'keyboard_type') {
          this.emitUpdate(`Blindly typing "${instruction.value}" on keyboard...`);
          await browser.keyboard_type(instruction.value);
        } else if (instruction.action === 'press_key') {
          this.emitUpdate(`Pressing ${instruction.key}...`);
          await browser.press(instruction.key || 'Enter');
        } else if (instruction.action === 'wait') {
          this.emitUpdate(`Waiting for Cloudflare or page load...`, 'info');
          await browser.page.waitForTimeout(5000);
        } else if (instruction.action === 'solve_captcha') {
          this.emitUpdate(`Initiating CAPTCHA solver cheat code...`, 'info');
          const solver = new CaptchaSolver(process.env.GEMINI_API_KEY);
          await solver.solveReCaptcha(browser.page, this.emitUpdate);
        } else if (instruction.action === 'ask_human') {
          this.emitUpdate(`Asking human: ${instruction.question}`, 'info');
          if (this.askHuman) {
            const humanResponse = await this.askHuman(instruction.question);
            if (this.isCancelled) break;
            this.emitUpdate(`Human responded: ${humanResponse}`, 'info');
          } else {
            this.emitUpdate(`No human-in-the-loop configured. Marking as done.`, 'info');
            break;
          }
        } else if (instruction.action === 'run_system_command') {
          this.emitUpdate(`Attempting to run command: ${instruction.command}`, 'info');
          // SAFEGUARD: Reject file deletion commands
          const dangerRegex = /\b(del|rm|Remove-Item|rd|rmdir)\b/i;
          if (dangerRegex.test(instruction.command)) {
            this.emitUpdate(`Command rejected by safety filter: Deletion is not allowed.`, 'error');
          } else {
            const { stdout, stderr } = await execPromise(instruction.command);
            this.emitUpdate(`Command Output: ${stdout.substring(0, 200)}`, 'info');
            if (stderr) this.emitUpdate(`Command Error: ${stderr.substring(0, 200)}`, 'error');
          }
        }
      } catch (err) {
        console.error("Action error:", err);
        this.emitUpdate(`❌ Action failed: ${err.message}`, 'error');
      }

      steps++;
      if (steps >= maxSteps) {
        this.emitUpdate("Reached maximum steps limit.");
      }
    }
  }
}

module.exports = AIAgent;
