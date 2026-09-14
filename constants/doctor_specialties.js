const DOCTOR_SPECIALTIES = Object.freeze([
  'طب القلب',
  'طب الأطفال',
  'الطب الباطني',
  'الجراحة العامة',
  'طب النساء والتوليد',
  'طب العيون',
  'طب الأنف والأذن والحنجرة',
  'طب الأسنان',
  'الأمراض الجلدية',
  'جراحة العظام',
  'جراحة الدماغ',
  'العمود الفقري',
  'رعاية حوامل',
]);

function normalizeDoctorSpecialty(value) {
  return String(value ?? '').trim();
}

function isValidDoctorSpecialty(value) {
  const normalized = normalizeDoctorSpecialty(value);
  return normalized.length > 0 && DOCTOR_SPECIALTIES.includes(normalized);
}

module.exports = {
  DOCTOR_SPECIALTIES,
  normalizeDoctorSpecialty,
  isValidDoctorSpecialty,
};
