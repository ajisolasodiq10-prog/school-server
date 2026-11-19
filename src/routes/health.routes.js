import { Router } from 'express';
import { getDbState } from '../config/db.js';

const router = Router();

// GET /api/health
router.get('/', (req, res) => {
  const database = getDbState();
  const healthy = database === 'connected';

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    message: healthy
      ? 'Server is running.'
      : 'Server is running, but the database is not connected.',
    database,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

export default router;
