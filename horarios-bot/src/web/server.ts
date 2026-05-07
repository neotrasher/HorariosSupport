import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import type { App as SlackApp } from '@slack/bolt';
import { config } from '../config';
import { authRouter, requireAuth, refreshSessionRole } from './routes/auth';
import { dashboardRouter } from './routes/dashboard';
import { buildHorariosRouter } from './routes/horarios';
import { miHorarioRouter } from './routes/miHorario';
import { agenteRouter } from './routes/agente';
import { agentesRouter } from './routes/agentes';
import { reportesRouter } from './routes/reportes';
import { plannerRouter } from './routes/planner';
import { buildSolicitudesRouter } from './routes/solicitudes';
import { settingsRouter } from './routes/settings';
import { auditoriaRouter } from './routes/auditoria';
import { calendarRouter } from './routes/calendar';
import { calendarTokenRouter } from './routes/calendarToken';

const SQLiteStore = require('connect-sqlite3')(session);

export function startWeb(slackApp: SlackApp | null = null) {
  const app = express();

  // Behind Caddy reverse proxy — trust X-Forwarded-* so secure cookies work
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  // In dev (ts-node): __dirname = src/web → views is ./views
  // In prod (dist/web): resolve from project root into src/web/views
  const viewsDir = fs.existsSync(path.join(__dirname, 'views'))
    ? path.join(__dirname, 'views')
    : path.join(__dirname, '..', '..', 'src', 'web', 'views');
  app.set('views', viewsDir);

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Inject path into views so the nav can highlight active links
  app.use((req, res, next) => {
    res.locals.currentPath = req.path;
    next();
  });

  const sessionDir = path.dirname(config.dbPath);
  app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: sessionDir }),
    secret: config.web.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: config.web.secureCookies, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
  }));

  // Healthcheck — no auth, no session — for external monitoring
  app.get('/health', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // Public ICS calendar feed — no auth required (protected by UUID token in URL)
  app.use('/cal', calendarRouter);

  // Rate limit OAuth endpoints to prevent abuse
  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Demasiados intentos. Intenta en un minuto.'
  });
  app.use('/auth', authLimiter, authRouter);

  app.use('/cal-token', requireAuth, refreshSessionRole, calendarTokenRouter);
  app.use('/mi-horario', requireAuth, refreshSessionRole, miHorarioRouter);
  app.use('/horarios/agente', requireAuth, refreshSessionRole, agenteRouter);
  app.use('/horarios', requireAuth, refreshSessionRole, buildHorariosRouter(slackApp));
  app.use('/solicitudes', requireAuth, refreshSessionRole, buildSolicitudesRouter(slackApp));
  app.use('/agentes', requireAuth, refreshSessionRole, agentesRouter);
  app.use('/reportes', requireAuth, refreshSessionRole, reportesRouter);
  app.use('/planner', requireAuth, refreshSessionRole, plannerRouter);
  app.use('/settings', requireAuth, refreshSessionRole, settingsRouter);
  app.use('/auditoria', requireAuth, refreshSessionRole, auditoriaRouter);
  app.use('/', requireAuth, refreshSessionRole, dashboardRouter);

  // Global error handler — must be last
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    console.error(`[web] error on ${req.method} ${req.path}:`, err);
    const user = (req.session as any)?.user;
    res.status(500).render('error', {
      message: 'Algo salio mal. Intenta de nuevo o contacta al admin.',
      user: user ?? null
    });
  });

  const port = config.web.port;
  app.listen(port, () => {
    console.log(`🌐 Web server on http://localhost:${port}`);
  });
}
