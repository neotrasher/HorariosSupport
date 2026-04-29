// One-shot script: sends the punch-button DM to every agent currently mid-shift
// who hasn't yet clocked in. Use after enabling the bot mid-day so agents who
// already started their shift get buttons to mark entry.
//
// Run from /root/horarios-bot:  node scripts/send-buttons-to-inshift.js

const { App, LogLevel } = require('@slack/bolt');
const { DateTime } = require('luxon');
require('dotenv/config');

const { getAllShiftsForDate, shiftWindow } = require('../dist/services/schedule');
const { getAgentByPlannerId } = require('../dist/services/agents');
const { getShiftState, setShiftMessage, markAlertSent } = require('../dist/services/punches');
const { punchButtonsBlocks } = require('../dist/ui/blocks');

(async () => {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: false,
    logLevel: LogLevel.WARN,
  });

  const now = DateTime.utc();
  const today = now.startOf('day');
  const yesterday = today.minus({ days: 1 });

  const candidates = [
    ...getAllShiftsForDate(today).map((s) => ({ ...s, baseDate: today })),
    ...getAllShiftsForDate(yesterday)
      .filter((s) => s.endHour > 24)
      .map((s) => ({ ...s, baseDate: yesterday })),
  ];

  let sent = 0;
  let skipped = 0;
  for (const c of candidates) {
    const w = shiftWindow(c.baseDate, c);
    if (now < w.start || now > w.end) {
      skipped++;
      continue;
    }
    const agent = getAgentByPlannerId(c.planner_id);
    if (!agent) {
      skipped++;
      continue;
    }
    const shiftDate = c.baseDate.toFormat('yyyy-LL-dd');
    const state = getShiftState(agent.slack_id, shiftDate, c.shift.id);
    if (state !== 'off') {
      skipped++;
      continue;
    }

    const blocks = punchButtonsBlocks({
      state,
      dept: c.dept,
      shift: c.shift,
      shiftDate,
      startISO: w.start.toISO(),
      endISO: w.end.toISO(),
    });

    try {
      const im = await app.client.conversations.open({ users: agent.slack_id });
      const ch = im.channel && im.channel.id;
      if (!ch) throw new Error('no IM channel');
      const r = await app.client.chat.postMessage({
        channel: ch,
        text: 'Marca tu entrada — ' + c.dept + ' ' + c.shift.label,
        blocks,
      });
      if (r.ts) setShiftMessage(agent.slack_id, shiftDate, c.shift.id, ch, r.ts);
      markAlertSent(agent.slack_id, shiftDate, c.shift.id, 'reminder');
      console.log('OK ' + agent.name + ' (' + c.dept + '.' + c.shift.id + ')');
      sent++;
    } catch (e) {
      console.log('FAIL ' + agent.name + ': ' + ((e.data && e.data.error) || e.message));
    }
  }
  console.log('Sent ' + sent + ' DMs; skipped ' + skipped);
  process.exit(0);
})();
