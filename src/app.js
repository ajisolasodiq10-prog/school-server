import express from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import auditRoutes from './routes/audit.routes.js';
import academicSessionRoutes from './routes/academicSession.routes.js';
import accountRoutes from './routes/account.routes.js';
import authRoutes from './routes/auth.routes.js';
import classRoutes from './routes/class.routes.js';
import healthRoutes from './routes/health.routes.js';
import parentRoutes from './routes/parent.routes.js';
import promotionRoutes from './routes/promotion.routes.js';
import resultRoutes from './routes/result.routes.js';
import resultSheetRoutes from './routes/resultSheet.routes.js';
import resultPinRoutes from './routes/resultPin.routes.js';
import resultAccessRoutes from './routes/resultAccess.routes.js';
import assignmentRoutes from './routes/assignment.routes.js';
import announcementRoutes from './routes/announcement.routes.js';
import calendarEventRoutes from './routes/calendarEvent.routes.js';
import materialRoutes from './routes/material.routes.js';
import timetableRoutes from './routes/timetable.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import profileRoutes from './routes/profile.routes.js';
import entryRequirementRoutes from './routes/entryRequirement.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import reportRoutes from './routes/report.routes.js';
import publicRoutes from './routes/public.routes.js';
import studentRoutes from './routes/student.routes.js';
import subjectRoutes from './routes/subject.routes.js';
import teacherRoutes from './routes/teacher.routes.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import { AppError } from './utils/AppError.js';

const app = express();

app.disable('x-powered-by');
if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

app.use(
  cors({
    origin(origin, callback) {
      // Allow the configured frontend(s) and non-browser tools (no Origin header).
      if (!origin || config.clientOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new AppError(403, 'Origin not allowed by CORS.', { code: 'CORS_FORBIDDEN' }));
    },
    // Tokens travel in the Authorization header, not in cookies, so credentials stay off.
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  })
);
app.use(express.json({ limit: '100kb' }));

// API responses can contain tokens and personal data: never let browsers or proxies cache them.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/teachers', teacherRoutes);
app.use('/api/parents', parentRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/academic-sessions', academicSessionRoutes);
app.use('/api/subjects', subjectRoutes);
app.use('/api/promotion-decisions', promotionRoutes);
app.use('/api/results', resultRoutes);
app.use('/api/result-sheets', resultSheetRoutes);
app.use('/api/calendar-events', calendarEventRoutes);
app.use('/api/materials', materialRoutes);
app.use('/api/timetables', timetableRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/result-pins', resultPinRoutes);
app.use('/api/result-access', resultAccessRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/entry-requirements', entryRequirementRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/reports', reportRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
