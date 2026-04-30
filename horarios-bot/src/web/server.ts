import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { authRouter, requireAuth } from './routes/auth';
import { dashboardRouter } from './routes/dashboard';
import { horariosRouter } from './routes/horarios';

const SQLiteStore = require('connect-sqlite3')(session);

export function startWeb() {
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

  // Rate limit OAuth endpoints to prevent abuse
  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Demasiados intentos. Intenta en un minuto.'
  });
  app.use('/auth', authLimiter, authRouter);

  app.use('/', requireAuth, dashboardRouter);
  app.use('/horarios', requireAuth, horariosRouter);

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
