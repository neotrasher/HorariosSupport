import { Router, Request, Response, NextFunction } from 'express';
import https from 'https';
import { config } from '../../config';
import { getAgentBySlackId } from '../../services/agents';

export const authRouter = Router();

declare module 'express-session' {
  interface SessionData {
    user?: {
      slack_id: string;
      name: string;
      avatar: string;
      role: 'admin' | 'manager' | 'agent' | 'viewer';
      dept?: string;
    };
  }
}

authRouter.get('/login', (req, res) => {
  res.render('login', { error: (req.query.error as string) || null });
});

authRouter.get('/slack', (_req, res) => {
  const params = new URLSearchParams({
    client_id: config.web.slackClientId,
    scope: 'openid,email,profile',
    redirect_uri: config.web.slackRedirectUri,
    response_type: 'code'
  });
  res.redirect(`https://slack.com/openid/connect/authorize?${params}`);
});

authRouter.get('/slack/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    res.redirect('/auth/login?error=no_code');
    return;
  }

  try {
    const tokenData = await slackTokenExchange(code);
    if (!tokenData.ok) {
      console.error('[oauth] token exchange failed:', tokenData.error || tokenData);
      res.redirect('/auth/login?error=token');
      return;
    }

    const userInfo = await slackUserInfo(tokenData.access_token);
    if (!userInfo.ok) {
      console.error('[oauth] userinfo failed:', userInfo.error || userInfo);
      res.redirect('/auth/login?error=userinfo');
      return;
    }

    const slackId = userInfo.sub;
    const name = userInfo.name || userInfo.email || 'Unknown';
    const avatar = userInfo.picture || '';

    const agent = getAgentBySlackId(slackId);
    const isAdmin = config.adminSlackIds.includes(slackId);
    const isManager = config.managerSlackIds.includes(slackId);

    let role: 'admin' | 'manager' | 'agent' | 'viewer' = 'viewer';
    if (isAdmin) role = 'admin';
    else if (isManager) role = 'manager';
    else if (agent) role = 'agent';

    (req.session as any).user = { slack_id: slackId, name, avatar, role, dept: agent?.dept };
    console.log(`[oauth] login ok: ${name} (${slackId}) role=${role}`);
    req.session.save(() => res.redirect('/'));
  } catch (e) {
    console.error('OAuth error:', e);
    res.redirect('/auth/login?error=exception');
  }
});

authRouter.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'));
});

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if ((req.session as any)?.user) return next();
  res.redirect('/auth/login');
}

export function requireManager(req: Request, res: Response, next: NextFunction) {
  const user = (req.session as any)?.user;
  if (user?.role === 'manager' || user?.role === 'admin') return next();
  res.status(403).render('error', { message: 'Acceso restringido a managers.' });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req.session as any)?.user;
  if (user?.role === 'admin') return next();
  res.status(403).render('error', { message: 'Acceso restringido al administrador.' });
}

function slackTokenExchange(code: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: config.web.slackClientId,
      client_secret: config.web.slackClientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.web.slackRedirectUri
    }).toString();

    const req = https.request({
      hostname: 'slack.com',
      path: '/api/openid.connect.token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Parse error')); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function slackUserInfo(accessToken: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'slack.com',
      path: '/api/openid.connect.userInfo',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Parse error')); } });
    });
    req.on('error', reject);
    req.end();
  });
}
