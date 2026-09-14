const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DOCTOR_SPECIALTIES,
  isValidDoctorSpecialty,
} = require('../constants/doctor_specialties');

test('doctor specialties list is fixed', () => {
  assert.equal(DOCTOR_SPECIALTIES.length, 10);
  assert.equal(DOCTOR_SPECIALTIES[0], 'طب القلب');
});

test('isValidDoctorSpecialty accepts known values only', () => {
  assert.equal(isValidDoctorSpecialty('طب العيون'), true);
  assert.equal(isValidDoctorSpecialty('طب عام'), false);
  assert.equal(isValidDoctorSpecialty(''), false);
});
