/**
 * Authenticated endpoints for managing the agent's own calendar token.
 *
 * POST /cal-token/generate  → creates/rotates token, redirects back to /mi-horario
 * POST /cal-token/revoke    → deletes token, redirects back to /mi-horario
 */
import { Router } from 'express';
import { generateToken, revokeToken } from '../../services/calendarTokens';

export const calendarTokenRouter = Router();

calendarTokenRouter.post('/generate', (req, res) => {
  const user = (req.session as any).user;
  generateToken(user.slack_id);
  res.redirect('/mi-horario#cal-sync');
});

calendarTokenRouter.post('/revoke', (req, res) => {
  const user = (req.session as any).user;
  revokeToken(user.slack_id);
  res.redirect('/mi-horario#cal-sync');
});
