/**
 * Taxi Metrics Service
 * مؤشرات جودة خدمة التكسي في الذاكرة — تُجمَّع من الأحداث وتُعرض للإدارة.
 * لا تعتمد على Redis: تعمل دائماً على مثيل Railway واحد (نافذة منزلقة).
 */

const MAX_ACCEPT_SAMPLES = 300;

const state = {
  counters: {
    created: 0,
    accepted: 0,
    completed: 0,
    cancelled: 0,
    missed: 0,
    transferred: 0,
  },
  acceptMs: [],
  driverAccepts: new Map(), // phone -> count
  lastResetAt: Date.now(),
};

function recordRequestCreated() {
  state.counters.created += 1;
}

function recordDriverAccepted(driverPhone) {
  const key = String(driverPhone || '').replace(/\D/g, '').slice(-10);
  state.driverAccepts.set(key, (state.driverAccepts.get(key) || 0) + 1);
}

function recordRequestAccepted(requestId, createdAtIso) {
  state.counters.accepted += 1;
  const at = Date.parse(String(createdAtIso || ''));
  if (Number.isFinite(at) && at > 0) {
    const durationMs = Math.max(0, Date.now() - at);
    state.acceptMs.push(durationMs);
    if (state.acceptMs.length > MAX_ACCEPT_SAMPLES) state.acceptMs.shift();
  }
}

function recordRequestCompleted() {
  state.counters.completed += 1;
}

function recordRequestCancelled() {
  state.counters.cancelled += 1;
}

function recordRequestMissed() {
  state.counters.missed += 1;
}

function recordRequestTransferred() {
  state.counters.transferred += 1;
}

function average(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function getTaxiMetrics() {
  const topDrivers = [...state.driverAccepts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([phone, count]) => ({ phone, count }));
  return {
    ...state.counters,
    acceptAvgMs: average(state.acceptMs),
    acceptMedianMs: median(state.acceptMs),
    acceptSamples: state.acceptMs.length,
    acceptRatePct: state.counters.created > 0
      ? Math.round((state.counters.accepted / state.counters.created) * 100)
      : 0,
    topDrivers,
    uptimeHours: Math.round((Date.now() - state.lastResetAt) / 3_600_000 * 10) / 10,
  };
}

module.exports = {
  recordRequestCreated,
  recordDriverAccepted,
  recordRequestAccepted,
  recordRequestCompleted,
  recordRequestCancelled,
  recordRequestMissed,
  recordRequestTransferred,
  getTaxiMetrics,
};
