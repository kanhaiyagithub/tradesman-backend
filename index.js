const http = require('http');
const dotenv = require('dotenv');

// dotenv.config({ path: './config/config.env' });
dotenv.config();

const app = require('./app');
const socket = require('./socket');
const {
  shouldStartBackgroundJobsInApiProcess,
  startBackgroundJobs,
} = require('./services/backgroundJobRunner');

const server = http.createServer(app);
socket.init(server);

const PORT = process.env.PORT || 5000;
let backgroundJobs = null;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  if (shouldStartBackgroundJobsInApiProcess()) {
    backgroundJobs = startBackgroundJobs();
    console.log('[BACKGROUND_JOBS] Started in API process');
  } else {
    console.log('[BACKGROUND_JOBS] Not started in API process');
  }
});

const stopBackgroundJobs = () => {
  if (backgroundJobs) {
    backgroundJobs.stop();
  }
};

// A forgotten await or promise must not take the API down silently or leave it half-working.
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT EXCEPTION]', error);
  stopBackgroundJobs();
  process.exit(1);
});

process.on('SIGINT', stopBackgroundJobs);
process.on('SIGTERM', stopBackgroundJobs);
