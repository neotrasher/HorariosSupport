import { Router } from 'express';
import { DateTime } from 'luxon';
import { vacationDaysUsedInYear } from '../../services/timeOff';
import {
  Agent, getAgentBySlackId, listAllAgents, createAgent,
  updateAgentFields, setActive, applyDbRoles,
  OPERATIONAL_FIELDS, SENSITIVE_FIELDS
} from '../../services/agents';
import { requireManager, requireAdmin } from './auth';
import { logAudit } from '../../services/audit';

export const agentesRouter = Router();

agentesRouter.use(requireManager);

agentesRouter.get('/', (req, res) => {
  const user = (req.session as any).user;
  const includeInactive = req.query.inactive === '1';
  const agents = listAllAgents(includeInactive);
  res.render('agentes-list', { user, agents, includeInactive, isAdmin: user.role === 'admin' });
});

agentesRouter.get('/nuevo', (req, res) => {
  const user = (req.session as any).user;
  res.render('agentes-form', {
    user, isAdmin: user.role === 'admin',
    mode: 'create',
    agent: emptyAgent(),
    error: null,
    vacationBalance: null
  });
});

agentesRouter.post('/nuevo', (req, res) => {
  const user = (req.session as any).user;
  const slackId = (req.body.slack_id as string || '').trim();
  const plannerIdRaw = (req.body.planner_id as string || '').trim();
  const name = (req.body.name as string || '').trim();
  const dept = (req.body.dept as string || '').trim();

  const renderError = (msg: string) => {
    const merged = { ...emptyAgent(), ...req.body };
    res.status(400).render('agentes-form', {
      user, isAdmin: user.role === 'admin', mode: 'create', agent: merged, error: msg,
      vacationBalance: null
    });
  };

  if (!slackId || !slackId.match(/^[A-Z0-9]+$/)) return renderError('slack_id invalido (ej: U01ABCDE).');
  const plannerId = parseInt(plannerIdRaw, 10);
  if (isNaN(plannerId)) return renderError('planner_id debe ser numero.');
  if (!name) return renderError('Nombre es obligatorio.');
  if (!['L1', 'L2', 'MGMT'].includes(dept)) return renderError('Dept debe ser L1, L2 o MGMT.');

  if (getAgentBySlackId(slackId)) return renderError('Ya existe un agente con ese slack_id.');

  try {
    // #5a: only admin can elevate a new agent's role. Manager always creates 'agent'.
    let role: 'agent' | 'manager' | 'admin' = 'agent';
    if (user.role === 'admin') {
      const requested = (req.body.role as string || '').trim();
      if (['agent', 'manager', 'admin'].includes(requested)) role = requested as any;
    }
    createAgent({ slackId, plannerId, name, dept, role });
    if (role !== 'agent') applyDbRoles();
  } catch (e: any) {
    return renderError(`Error al crear: ${e?.message || 'desconocido'}`);
  }

  // Apply operational fields from the form (sensitive are blocked unless admin — handled in update)
  const opFields = pickFields(req.body, OPERATIONAL_FIELDS as readonly string[]);
  delete (opFields as any).name;
  delete (opFields as any).dept;
  if (Object.keys(opFields).length) updateAgentFields(slackId, opFields);

  if (user.role === 'admin') {
    const sensFields = pickFields(req.body, SENSITIVE_FIELDS as readonly string[]);
    if (Object.keys(sensFields).length) updateAgentFields(slackId, sensFields);
  }

  res.redirect(`/agentes/${slackId}`);
});

agentesRouter.get('/:slackId', (req, res) => {
  const user = (req.session as any).user;
  const agent = getAgentBySlackId(req.params.slackId);
  if (!agent) {
    res.status(404).render('error', { message: 'Agente no encontrado.', user });
    return;
  }
  const year = DateTime.utc().year;
  const used = vacationDaysUsedInYear(agent.slack_id, year);
  const entitled = agent.vacation_days_per_year ?? null;
  const vacationBalance = {
    year, used,
    entitled,
    available: entitled === null ? 0 - used : entitled - used
  };
  res.render('agentes-form', {
    user, isAdmin: user.role === 'admin',
    mode: 'edit', agent, error: null,
    vacationBalance
  });
});

agentesRouter.post('/:slackId', (req, res) => {
  const user = (req.session as any).user;
  const slackId = req.params.slackId;
  const agent = getAgentBySlackId(slackId);
  if (!agent) {
    res.status(404).render('error', { message: 'Agente no encontrado.', user });
    return;
  }

  // Operational fields — both managers and admin can edit
  const opFields = pickFields(req.body, [...OPERATIONAL_FIELDS, 'role']);
  // dept must be L1/L2/MGMT
  if (opFields.dept && !['L1', 'L2', 'MGMT'].includes(opFields.dept as string)) {
    res.status(400).render('error', { message: 'Dept debe ser L1, L2 o MGMT.', user });
    return;
  }
  // Role: admin can grant any role (incl. admin/manager). Manager cannot
  // change roles (silently ignore). Agent value must be in the whitelist.
  if ('role' in opFields) {
    const newRole = opFields.role as string;
    if (user.role !== 'admin') {
      delete (opFields as any).role;
    } else if (!['agent', 'manager', 'admin'].includes(newRole)) {
      delete (opFields as any).role;
    }
  }
  if (Object.keys(opFields).length) updateAgentFields(slackId, opFields);

  // If role changed, refresh in-memory role lists so cron/jobs see the update
  if ('role' in opFields) {
    applyDbRoles();
    logAudit({
      actorSlackId: user.slack_id, actorName: user.name,
      action: 'agent.role.change',
      targetKind: 'agent', targetId: slackId,
      summary: `Cambio rol de ${agent.name}: ${agent.role} -> ${opFields.role}`,
      payload: { slackId, agentName: agent.name, fromRole: agent.role, toRole: opFields.role }
    });
  }

  // Sensitive fields — admin only. Defense in depth: even if the form was tampered,
  // we ignore the sensitive keys for non-admin users.
  if (user.role === 'admin') {
    const sensFields = pickFields(req.body, SENSITIVE_FIELDS as readonly string[]);
    // Coerce numeric fields (sqlite is lax but we want clean nulls vs zero)
    for (const numKey of ['salary_current', 'salary_previous', 'salary_new', 'last_adjustment_pct', 'holiday_day_amount']) {
      if (numKey in sensFields) {
        const raw = sensFields[numKey];
        if (raw === '' || raw === undefined || raw === null) sensFields[numKey] = null;
        else {
          const n = parseFloat(String(raw));
          sensFields[numKey] = isNaN(n) ? null : n;
        }
      }
    }
    if (Object.keys(sensFields).length) updateAgentFields(slackId, sensFields);
  }

  res.redirect('/agentes');
});

/**
 * Inline update of a single sensitive field (admin only). Used by the editable
 * cells in the agents list. JSON in / JSON out so the JS can update the UI
 * without a full reload.
 */
agentesRouter.post('/:slackId/inline-update', requireAdmin, (req, res) => {
  const slackId = req.params.slackId;
  const agent = getAgentBySlackId(slackId);
  if (!agent) {
    res.status(404).json({ ok: false, error: 'agent not found' });
    return;
  }

  const field = req.body.field as string;
  const allowedInline = ['id_number', 'salary_current'];
  if (!allowedInline.includes(field)) {
    res.status(400).json({ ok: false, error: 'field not allowed' });
    return;
  }

  let value: any = req.body.value;
  if (field === 'salary_current') {
    if (value === '' || value === null || value === undefined) value = null;
    else {
      const n = parseFloat(String(value));
      value = isNaN(n) ? null : n;
    }
  } else {
    value = (typeof value === 'string' && value.trim() === '') ? null : value;
  }

  updateAgentFields(slackId, { [field]: value });
  res.json({ ok: true });
});

/**
 * Apply a salary raise: snapshots current as previous, sets new = current * (1+pct/100),
 * records pct and date. Admin only.
 */
agentesRouter.post('/:slackId/apply-raise', requireAdmin, (req, res) => {
  const slackId = req.params.slackId;
  const agent = getAgentBySlackId(slackId);
  if (!agent) {
    res.status(404).render('error', { message: 'Agente no encontrado.', user: (req.session as any).user });
    return;
  }

  const pct = parseFloat(String(req.body.pct || ''));
  if (isNaN(pct) || pct === 0) {
    res.redirect('/agentes');
    return;
  }
  const current = agent.salary_current;
  if (current == null) {
    res.status(400).render('error', { message: 'No se puede aplicar aumento: el agente no tiene salario actual.', user: (req.session as any).user });
    return;
  }
  const newSalary = +(current * (1 + pct / 100)).toFixed(2);

  updateAgentFields(slackId, {
    salary_previous: current,
    salary_current: newSalary,
    salary_new: newSalary,
    last_adjustment_pct: pct,
    last_salary_adjustment_date: DateTime.utc().toFormat('yyyy-LL-dd')
  });

  res.redirect('/agentes');
});

agentesRouter.post('/:slackId/toggle-active', (req, res) => {
  const user = (req.session as any).user;
  const slackId = req.params.slackId;
  const agent = getAgentBySlackId(slackId);
  if (!agent) {
    res.status(404).render('error', { message: 'Agente no encontrado.', user });
    return;
  }
  setActive(slackId, !agent.active);
  res.redirect(`/agentes/${slackId}`);
});

function pickFields<T extends Record<string, any>>(body: T, allowedKeys: readonly string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of allowedKeys) {
    if (k in body) {
      const v = body[k];
      out[k] = v === '' ? null : v;
    }
  }
  return out;
}

function emptyAgent(): Partial<Agent> {
  return {
    slack_id: '', planner_id: 0, name: '', dept: 'L1', role: 'agent', active: 1
  };
}
