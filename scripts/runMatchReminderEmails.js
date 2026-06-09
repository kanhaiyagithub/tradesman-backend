const dotenv = require('dotenv');
dotenv.config();

const { runMatchReminderEmails } = require('../services/emailReminderService');

runMatchReminderEmails()
  .then((result) => {
    console.log('[EMAIL_REMINDER] Manual reminder run completed', result);
    process.exit(0);
  })
  .catch((error) => {
    console.error('[EMAIL_REMINDER] Manual reminder run failed', error);
    process.exit(1);
  });
