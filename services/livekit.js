const { createHmac, randomBytes } = require('crypto');

const TOKEN_TTL_SECONDS = 3600;

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * عنوان محلي (LAN / loopback) لا تصل إليه هواتف المستخدمين خارج نفس الشبكة،
 * فنُبلّغ العميل بذلك بدل ترك المكالمة تفشل بخطأ شبكة غامض.
 */
function isPrivateHostUrl(url) {
  const host = String(url || '')
    .replace(/^wss?:\/\//i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .trim()
    .toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) {
    return true;
  }
  if (/^169\.254\./.test(host)) return true;
  const secondOctet = /^172\.(\d{1,3})\./.exec(host);
  if (secondOctet) {
    const value = Number(secondOctet[1]);
    if (value >= 16 && value <= 31) return true;
  }
  return false;
}

function getLiveKitConfig() {
  const apiKey = String(process.env.LIVEKIT_API_KEY || '').trim();
  const apiSecret = String(process.env.LIVEKIT_API_SECRET || '').trim();
  let url = String(process.env.LIVEKIT_URL || '').trim();
  // توحيد شكل العنوان للعميل (ws/wss بدون شرطة مائلة زائدة)
  url = url.replace(/\/+$/, '');
  const privateHost = isPrivateHostUrl(url);
  return {
    apiKey,
    apiSecret,
    url,
    privateHost,
    enabled: Boolean(apiKey && apiSecret && url),
    publiclyReachable: Boolean(apiKey && apiSecret && url) && !privateHost,
  };
}

function buildRoomId(threadType, threadId, callNonce = '') {
  const safeType = String(threadType || 'order')
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 12)
    .toLowerCase();
  const safeId = String(threadId || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 28);
  const safeNonce = String(callNonce || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 12);
  const suffix = safeNonce || randomBytes(6).toString('hex');
  return `lk_${safeType || 'thread'}_${safeId || 'x'}_${suffix}`.slice(0, 64);
}

function userIdFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '0';
  return digits.length > 15 ? digits.slice(-15) : digits;
}

function buildStreamId(userId) {
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return `a_${safe || 'u'}`.slice(0, 64);
}

function signAccessToken({ apiKey, apiSecret, identity, roomName, ttlSeconds = TOKEN_TTL_SECONDS }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: apiKey,
    sub: identity,
    nbf: now - 10,
    exp: now + ttlSeconds,
    name: identity,
    video: {
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
    },
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', apiSecret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function buildRtcToken(roomId, userId) {
  const { apiKey, apiSecret, url, enabled } = getLiveKitConfig();
  if (!enabled) {
    throw new Error('LiveKit is not configured on the server.');
  }

  const token = signAccessToken({
    apiKey,
    apiSecret,
    identity: String(userId),
    roomName: roomId,
  });

  return {
    provider: 'livekit',
    appId: 0,
    token,
    livekitUrl: url,
    roomId,
    channelName: roomId,
    userId: String(userId),
    streamId: buildStreamId(userId),
    expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
}

function buildCallSession(threadType, threadId, callerPhone) {
  const roomId = buildRoomId(threadType, threadId);
  const userId = userIdFromPhone(callerPhone);
  const session = buildRtcToken(roomId, userId);
  return {
    ...session,
    threadType: String(threadType || 'order').trim(),
    threadId: String(threadId || '').trim(),
  };
}

module.exports = {
  getLiveKitConfig,
  isPrivateHostUrl,
  buildRoomId,
  userIdFromPhone,
  buildStreamId,
  buildRtcToken,
  buildCallSession,
  signAccessToken,
};
