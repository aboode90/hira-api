const zego = require('./zego');
const livekit = require('./livekit');

/**
 * LiveKit هو المزود الأساسي المعتمد.
 * استخدم VOICE_PROVIDER=zego فقط كاحتياطي صريح.
 */
function getVoiceProvider() {
  const raw = String(process.env.VOICE_PROVIDER || 'livekit').trim().toLowerCase();
  if (raw === 'zego') return 'zego';
  return 'livekit';
}

function getVoiceConfig() {
  const provider = getVoiceProvider();
  if (provider === 'livekit') {
    const cfg = livekit.getLiveKitConfig();
    return {
      provider: 'livekit',
      enabled: cfg.enabled,
      appId: 0,
      livekitUrl: cfg.enabled ? cfg.url : '',
      publiclyReachable: cfg.publiclyReachable,
      privateHost: cfg.privateHost,
    };
  }
  const cfg = zego.getZegoConfig();
  return {
    provider: 'zego',
    enabled: cfg.enabled,
    appId: cfg.enabled ? cfg.appId : 0,
    livekitUrl: '',
    publiclyReachable: cfg.enabled,
    privateHost: false,
  };
}

function describeVoiceStatus() {
  const config = getVoiceConfig();
  const livekitCfg = livekit.getLiveKitConfig();
  const zegoCfg = zego.getZegoConfig();
  return {
    provider: config.provider,
    enabled: config.enabled,
    livekitConfigured: livekitCfg.enabled,
    livekitPubliclyReachable: livekitCfg.publiclyReachable,
    livekitPrivateHost: livekitCfg.privateHost,
    zegoConfigured: zegoCfg.enabled,
    livekitUrl: livekitCfg.enabled ? livekitCfg.url : '',
  };
}

function buildRoomId(threadType, threadId, callNonce = '') {
  return getVoiceProvider() === 'livekit'
    ? livekit.buildRoomId(threadType, threadId, callNonce)
    : zego.buildRoomId(threadType, threadId, callNonce);
}

function userIdFromPhone(phone) {
  return getVoiceProvider() === 'livekit'
    ? livekit.userIdFromPhone(phone)
    : zego.userIdFromPhone(phone);
}

function buildRtcToken(roomId, userId) {
  if (getVoiceProvider() === 'livekit') {
    return livekit.buildRtcToken(roomId, userId);
  }
  return {
    provider: 'zego',
    livekitUrl: '',
    ...zego.buildRtcToken(roomId, userId),
  };
}

function buildCallSession(threadType, threadId, callerPhone) {
  if (getVoiceProvider() === 'livekit') {
    return livekit.buildCallSession(threadType, threadId, callerPhone);
  }
  return {
    provider: 'zego',
    livekitUrl: '',
    ...zego.buildCallSession(threadType, threadId, callerPhone),
  };
}

module.exports = {
  getVoiceProvider,
  getVoiceConfig,
  describeVoiceStatus,
  buildRoomId,
  userIdFromPhone,
  buildRtcToken,
  buildCallSession,
};
