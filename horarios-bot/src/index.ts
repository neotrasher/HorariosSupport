import { App, LogLevel } from '@slack/bolt';
import cron from 'node-cron';
import { config } from './config';
import { migrate } from './db';
import { registerHorarioImport } from './commands/horarioImport';
import { registerHorarioLink } from './commands/horarioLink';
import { registerHorarioStatus } from './commands/horarioStatus';
import { registerHorarioHoy } from './commands/horarioHoy';
import { registerPunchFix } from './commands/punchFix';
import { registerPunchTest } from './commands/punchTest';
import { registerPunchReset } from './commands/punchReset';
import { registerHorarioSwap } from './commands/horarioSwap';
import { registerPunchButtons } from './actions/punchButtons';
import { registerSwapButtons } from './actions/swapButtons';
import { runShiftReminder } from './jobs/shiftReminder';
import { runLateChecker } from './jobs/lateChecker';
import { runBreakOverdueChecker } from './jobs/breakOverdueChecker';

async function main() {
  migrate();

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
    logLevel: config.logLevel === 'debug' ? LogLevel.DEBUG : LogLevel.INFO
  });

  // Slash commands
  registerHorarioImport(app);
  registerHorarioLink(app);
  registerHorarioStatus(app);
  registerHorarioHoy(app);
  registerPunchFix(app);
  registerPunchTest(app);
  registerPunchReset(app);
  registerHorarioSwap(app);

  // Button actions
  registerPunchButtons(app);
  registerSwapButtons(app);

  // Health DM (mention the bot anywhere)
  app.event('app_mention', async ({ event, say }) => {
    await say({ text: `👋 Hola <@${event.user}>, estoy en línea. Prueba \`/horario-hoy\` o \`/horario-status\`.` });
  });

  await app.start();
  console.log('⚡ Horarios bot running (Socket Mode)');

  // Cron jobs — every minute
  if (config.cronDisabled) {
    console.log('⏸️  Cron DISABLED (CRON_DISABLED=true). Reminders and late alerts will NOT fire.');
  } else {
    cron.schedule('* * * * *', () => {
      runShiftReminder(app).catch(e => console.error('reminder job error:', e));
      runLateChecker(app).catch(e => console.error('late job error:', e));
      runBreakOverdueChecker(app).catch(e => console.error('break overdue job error:', e));
    });
    console.log(`Cron: reminders ${config.reminderLeadMin}m before · late ${config.lateThresholdMin}m · break max ${config.breakMaxMin}m · break-in lockout ${config.breakInLockoutMin}m`);
  }
  console.log(`Managers: ${config.managerSlackIds.join(', ') || '(none configured)'}`);
  console.log(`Attendance channel: ${config.attendanceChannelId || '(none — DM only)'}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
