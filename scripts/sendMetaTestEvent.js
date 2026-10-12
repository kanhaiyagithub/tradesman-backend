const crypto = require('crypto');
const dotenv = require('dotenv');
dotenv.config();

const { getConfig, postEvents } = require('../services/metaConversionService');
const { buildEvent } = require('../utils/metaCapi');

/**
 * Sends ONE fake event to Meta's Test Events tool. Never touches the database.
 *
 * Usage:
 *   npm run meta:test              -> CompleteRegistration
 *   npm run meta:test -- subscribe -> Subscribe
 */
const main = async () => {
  const config = getConfig();
  const kind = String(process.argv[2] || 'registration').toLowerCase();

  if (!config.enabled) {
    console.error('[META_TEST] META_CAPI_ENABLED is not "true"; refusing to send.');
    return 1;
  }

  if (!config.testEventCode) {
    console.error('[META_TEST] META_TEST_EVENT_CODE is not set; refusing to send (this script only sends test events).');
    return 1;
  }

  if (!config.accessToken || !config.datasetId) {
    console.error('[META_TEST] META_CAPI_ACCESS_TOKEN or META_DATASET_ID is missing.');
    return 1;
  }

  if (kind !== 'registration' && kind !== 'subscribe') {
    console.error('[META_TEST] Unknown event type. Use "registration" (default) or "subscribe".');
    return 1;
  }

  const id = crypto.randomBytes(4).toString('hex');
  const isSubscribe = kind === 'subscribe';

  const event = buildEvent({
    eventName: isSubscribe ? 'Subscribe' : 'CompleteRegistration',
    eventTime: Math.floor(Date.now() / 1000),
    eventId: `test_${kind}_${id}`,
    email: 'meta-test@example.com',
    phone: '0412345678',
    userId: `test-${id}`,
    attribution: {
      platform: 'android',
      advertisingId: crypto.randomUUID(),
      anonId: crypto.randomUUID(),
      advertiserTrackingEnabled: true,
      applicationTrackingEnabled: true,
      appPackage: 'com.example.touringtrades',
      appVersionCode: '1',
      appVersionName: '1.0.0',
      osVersion: '14',
      deviceModel: 'Pixel 7',
      locale: 'en_AU',
      timezoneAbbr: 'AEST',
      timezoneName: 'Australia/Sydney',
      carrier: 'Telstra',
      screenWidth: 1080,
      screenHeight: 2400,
      screenDensity: 2.75,
      cpuCores: 8,
      totalStorageGb: 128,
      freeStorageGb: 64,
      lastIp: '203.0.113.10',
      lastUserAgent: 'MetaTestScript/1.0',
    },
    customData: isSubscribe
      ? { value: 9.99, currency: 'AUD', content_name: 'Test plan', user_role: 'tradesman' }
      : { registration_method: 'email', user_role: 'client', status: true },
    defaultTrackingEnabled: config.defaultTrackingEnabled,
    defaultPhoneCountryCode: config.defaultPhoneCountryCode,
  });

  console.log(`[META_TEST] Sending ${event.event_name} to dataset ${config.datasetId} with test code ${config.testEventCode}...`);
  const result = await postEvents(config, [event], config.testEventCode);

  if (!result.ok) {
    console.error('[META_TEST] Failed:', result.error);
    return 1;
  }

  console.log('[META_TEST] Accepted by Meta. fbtrace_id:', result.fbtraceId || 'n/a');
  console.log('[META_TEST] Check Events Manager > Test Events for the event.');
  return 0;
};

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[META_TEST] Unexpected error:', error.message);
    process.exit(1);
  });
