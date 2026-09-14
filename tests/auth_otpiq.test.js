const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadAuthModule(env = {}) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  const modulePath = path.join(__dirname, '..', 'routes', 'auth.js');
  delete require.cache[require.resolve(modulePath)];
  const authModule = require(modulePath);

  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return authModule;
}

test('resolveOtpiqProvider maps channels to configured providers', () => {
  const authModule = loadAuthModule({
    OTPIQ_SMS_PROVIDER: 'sms',
    OTPIQ_WHATSAPP_PROVIDER: 'whatsapp',
    OTPIQ_TELEGRAM_PROVIDER: 'telegram',
  });

  assert.equal(authModule.resolveOtpiqProvider('sms'), 'sms');
  assert.equal(authModule.resolveOtpiqProvider('whatsapp'), 'whatsapp');
  assert.equal(authModule.resolveOtpiqProvider('telegram'), 'telegram');
  assert.equal(authModule.resolveOtpiqProvider(''), 'sms');
});
