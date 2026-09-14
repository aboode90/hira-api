function parseTimeToMinutes(raw) {
  const value = String(raw || '').trim();
  if (!value || value.toLowerCase() === 'null') return null;

  const hourOnly = /^(\d{1,2})$/.exec(value);
  if (hourOnly) {
    const hour = Number.parseInt(hourOnly[1], 10);
    if (hour >= 0 && hour <= 23) return hour * 60;
  }

  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute * 1;
}

const PLATFORM_NIGHT_CLOSE_HOUR = 1;
const PLATFORM_NIGHT_REOPEN_HOUR = 9;
const PLATFORM_NIGHT_CLOSED_MESSAGE_AR =
  'مغلق حالياً — لا يمكن الطلب بعد الساعة 1 صباحاً.';

function nowInBaghdad() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + 3 * 3600000);
}

function isPlatformNightClosed(referenceDate = nowInBaghdad()) {
  const hour = referenceDate.getHours();
  return hour >= PLATFORM_NIGHT_CLOSE_HOUR && hour < PLATFORM_NIGHT_REOPEN_HOUR;
}

function isWithinWorkingHours(openTime, closeTime, referenceDate = nowInBaghdad()) {
  const openMin = parseTimeToMinutes(openTime);
  const closeMin = parseTimeToMinutes(closeTime);
  if (openMin == null || closeMin == null) return true;
  if (openMin === closeMin) return true;

  const nowMin = referenceDate.getHours() * 60 + referenceDate.getMinutes();
  if (closeMin > openMin) {
    return nowMin >= openMin && nowMin < closeMin;
  }
  return nowMin >= openMin || nowMin < closeMin;
}

function workingHoursLabel(openTime, closeTime) {
  const open = String(openTime || '').trim().slice(0, 5);
  const close = String(closeTime || '').trim().slice(0, 5);
  if (!open && !close) return '';
  if (!open) return `حتى ${close}`;
  if (!close) return `من ${open}`;
  return `${open} — ${close}`;
}

function pickField(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const value = String(source[key] || '').trim();
      if (value) return value;
    }
  }
  return '';
}

function resolveMerchantHours(profile) {
  const info =
    profile?.professional_info && typeof profile.professional_info === 'object'
      ? profile.professional_info
      : {};
  const store =
    profile?.store_data && typeof profile.store_data === 'object'
      ? profile.store_data
      : {};
  const sources = [profile, info, store, store.professionalInfo, store.professional_info];

  const morningOpenTime = pickField(sources, [
    'morningOpenTime',
    'morning_open_time',
  ]);
  const morningCloseTime = pickField(sources, [
    'morningCloseTime',
    'morning_close_time',
  ]);
  const eveningOpenTime = pickField(sources, [
    'eveningOpenTime',
    'evening_open_time',
  ]);
  const eveningCloseTime = pickField(sources, [
    'eveningCloseTime',
    'evening_close_time',
  ]);

  const shifts = [];
  if (morningOpenTime && morningCloseTime) {
    shifts.push({ openTime: morningOpenTime, closeTime: morningCloseTime });
  }
  if (eveningOpenTime && eveningCloseTime) {
    shifts.push({ openTime: eveningOpenTime, closeTime: eveningCloseTime });
  }

  return {
    openTime: String(profile?.open_time || profile?.openTime || info.openTime || '').trim(),
    closeTime: String(
      profile?.close_time || profile?.closeTime || info.closeTime || ''
    ).trim(),
    shifts,
  };
}

function isWithinAnyShift(shifts, referenceDate = nowInBaghdad()) {
  if (!Array.isArray(shifts) || shifts.length === 0) return null;
  return shifts.some((shift) =>
    isWithinWorkingHours(shift.openTime, shift.closeTime, referenceDate),
  );
}

function merchantAvailabilityCheck(
  profile,
  referenceDate = nowInBaghdad(),
  {
    closedManualMessageAr,
    outsideHoursWithLabelAr,
    outsideHoursFallbackAr,
  } = {},
) {
  if (isPlatformNightClosed(referenceDate)) {
    return {
      allowed: false,
      messageAr: PLATFORM_NIGHT_CLOSED_MESSAGE_AR,
    };
  }

  if (!profile) {
    return { allowed: true, messageAr: '' };
  }

  if (profile.is_open === false) {
    return {
      allowed: false,
      messageAr: closedManualMessageAr,
    };
  }

  const { openTime, closeTime, shifts } = resolveMerchantHours(profile);
  const withinShifts = isWithinAnyShift(shifts, referenceDate);
  if (withinShifts === true) {
    return { allowed: true, messageAr: '' };
  }
  if (withinShifts === false) {
    const labels = shifts
      .map((shift) => workingHoursLabel(shift.openTime, shift.closeTime))
      .filter(Boolean);
    return {
      allowed: false,
      messageAr: labels.length
        ? outsideHoursWithLabelAr(labels.join(' · '))
        : outsideHoursFallbackAr,
    };
  }

  if (isWithinWorkingHours(openTime, closeTime, referenceDate)) {
    return { allowed: true, messageAr: '' };
  }

  const hours = workingHoursLabel(openTime, closeTime);
  return {
    allowed: false,
    messageAr: hours
      ? outsideHoursWithLabelAr(hours)
      : outsideHoursFallbackAr,
  };
}

function merchantAcceptsCustomerCalls(profile, referenceDate = nowInBaghdad()) {
  return merchantAvailabilityCheck(profile, referenceDate, {
    closedManualMessageAr: 'المتجر مغلق حالياً — الاتصال غير متاح.',
    outsideHoursWithLabelAr: (hours) =>
      `انتهى وقت الدوام (${hours}). الاتصال متاح خلال ساعات العمل فقط.`,
    outsideHoursFallbackAr:
      'انتهى وقت الدوام. الاتصال متاح خلال ساعات العمل فقط.',
  });
}

function merchantAcceptsCustomerOrders(profile, referenceDate = nowInBaghdad()) {
  return merchantAvailabilityCheck(profile, referenceDate, {
    closedManualMessageAr:
      'المتجر مغلق حالياً — لا يمكن إضافة المنتجات إلى السلة.',
    outsideHoursWithLabelAr: (hours) =>
      `انتهى وقت الدوام (${hours}). لا يمكن الطلب خارج ساعات العمل.`,
    outsideHoursFallbackAr:
      'انتهى وقت الدوام. لا يمكن الطلب خارج ساعات العمل.',
  });
}

module.exports = {
  parseTimeToMinutes,
  nowInBaghdad,
  isWithinWorkingHours,
  workingHoursLabel,
  resolveMerchantHours,
  merchantAcceptsCustomerCalls,
  merchantAcceptsCustomerOrders,
  isPlatformNightClosed,
  PLATFORM_NIGHT_CLOSED_MESSAGE_AR,
  PLATFORM_NIGHT_CLOSE_HOUR,
  PLATFORM_NIGHT_REOPEN_HOUR,
};
