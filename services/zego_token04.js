'use strict';

const crypto = require('crypto');

/**
 * ZEGO Token04 — نفس خوارزمية zego_server_assistant (AES-256-CBC).
 * Token = "04" + Base64(expire + ivLen + iv + cipherLen + cipher)
 */
function generateToken04(appId, userId, serverSecret, effectiveTimeInSeconds, payload = '') {
  if (!appId || !userId || !serverSecret) {
    throw new Error('ZEGO token: missing appId, userId, or serverSecret.');
  }

  const secret = String(serverSecret);
  if (secret.length !== 32) {
    throw new Error('ZEGO ServerSecret must be 32 bytes.');
  }

  const time = Math.floor(Date.now() / 1000);
  const expire = time + Number(effectiveTimeInSeconds || 3600);

  const body = {
    app_id: Number(appId),
    user_id: String(userId),
    nonce: Math.floor(Math.random() * 2147483647),
    ctime: time,
    expire,
  };

  const payloadText = String(payload || '').trim();
  if (payloadText) {
    body.payload = payloadText;
  }

  let iv = Math.random().toString().substring(2, 18);
  if (iv.length < 16) {
    iv += iv.substring(0, 16 - iv.length);
  }
  iv = iv.slice(0, 16);

  const key = Buffer.from(secret, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, Buffer.from(iv, 'utf8'));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(body), 'utf8'),
    cipher.final(),
  ]);

  const buffer = Buffer.alloc(8 + 2 + 16 + 2 + encrypted.length);
  buffer.writeUInt32BE(0, 0);
  buffer.writeUInt32BE(expire, 4);
  buffer.writeUInt16BE(iv.length, 8);
  Buffer.from(iv, 'utf8').copy(buffer, 10);
  buffer.writeUInt16BE(encrypted.length, 26);
  encrypted.copy(buffer, 28);

  return `04${buffer.toString('base64')}`;
}

module.exports = { generateToken04 };
