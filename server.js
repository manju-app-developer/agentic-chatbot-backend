const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const dotenv = require('dotenv');
const AgentBrowser = require('./browser');
const AIAgent = require('./agent');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
  
  let browser = null;
  let agentInstance = null;
  let resolveHumanWait = null;
  let resolveStepApproval = null;

  socket.on('cancel_task', () => {
    if (agentInstance) {
      agentInstance.abort();
      socket.emit('status', { message: 'Task terminated by user.', type: 'error' });
      socket.emit('task_complete', { reason: 'terminated' });
    }
  });

  socket.on('human_input', (data) => {
    if (resolveHumanWait) {
      socket.emit('status', { message: 'Resuming task...', type: 'info' });
      resolveHumanWait(data.input);
      resolveHumanWait = null;
    }
  });

  socket.on('step_decision', (data) => {
    if (resolveStepApproval) {
      resolveStepApproval(data);
      resolveStepApproval = null;
    }
  });

  socket.on('start_task', async (data) => {
    const { task } = data;
    socket.emit('status', { message: 'Initializing task...', type: 'info' });
    
    try {
      browser = new AgentBrowser();
      
      const apiKeys = [
        process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY,
        process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3,
        process.env.GEMINI_API_KEY_4,
        process.env.GEMINI_API_KEY_5
      ].filter(Boolean);

      if (apiKeys.length === 0) {
          throw new Error("No Gemini API keys found in .env");
      }

      agentInstance = new AIAgent(apiKeys, (msg, type = 'info') => {
        socket.emit('status', { message: msg, type });
      }, async (question) => {
        socket.emit('require_human', { message: question });
        return new Promise((resolve) => {
          resolveHumanWait = resolve;
        });
      }, async (actionDetails) => {
        socket.emit('require_step_approval', { action: actionDetails });
        return new Promise((resolve) => {
          resolveStepApproval = resolve;
        });
      });

      socket.emit('status', { message: 'Agent loop started.', type: 'info' });
      
      await agentInstance.runLoop(browser, task);
      
      socket.emit('status', { message: 'Task finished!', type: 'info' });
      socket.emit('task_complete');
    } catch (err) {
      console.error(err);
      socket.emit('status', { message: `Error: ${err.message}`, type: 'error' });
    }
  });

  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    if (browser) {
      await browser.close();
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
