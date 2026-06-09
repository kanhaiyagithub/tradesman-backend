const dotenv = require('dotenv');
dotenv.config();

const { sendMail } = require('../services/emailService');

const to = process.argv[2] || process.env.EMAIL_TEST_TO;

if (!to) {
  console.error('[EMAIL_TEST] Missing recipient email. Usage: npm run email:test -- test@example.com');
  process.exit(1);
}

sendMail({
  to,
  subject: 'Touring Trades Test Email',
  html: '<h2>Email notifications are working.</h2><p>This is a test email from the Touring Trades backend.</p>',
})
  .then((result) => {
    if (!result?.success) {
      console.error('[EMAIL_TEST] Failed to send test email', result);
      process.exit(1);
    }

    console.log('[EMAIL_TEST] Test email sent successfully', result);
    process.exit(0);
  })
  .catch((error) => {
    console.error('[EMAIL_TEST] Test email failed', error);
    process.exit(1);
  });
