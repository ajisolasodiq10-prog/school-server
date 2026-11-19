import { config } from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import app from './app.js';
import './models/index.js'; // registers all Mongoose models and builds their indexes

const start = async () => {
  try {
    await connectDB();
  } catch {
    // connectDB has already logged a clear explanation.
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    console.log(`[server] Running on http://localhost:${config.port} (${config.nodeEnv})`);
    console.log(`[server] Health check: http://localhost:${config.port}/api/health`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[server] Port ${config.port} is already in use. Change PORT in .env.`);
    } else {
      console.error(`[server] ${error.message}`);
    }
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`\n[server] ${signal} received, shutting down...`);
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
  process.exit(1);
});

start();
