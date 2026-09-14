function readCourierProfileFromState(state) {
  if (!state || typeof state !== 'object') return null;
  const profile = state.courierProfile;
  if (!profile || typeof profile !== 'object') return null;
  return profile;
}

function isCourierProfileComplete(profile) {
  if (!profile || typeof profile !== 'object') return false;
  const name = String(profile.name ?? '').trim();
  const contactPhone = String(profile.phone ?? '').trim();
  const homeAddress = String(
    profile.homeAddress ?? profile.address ?? profile.area ?? ''
  ).trim();
  const vehicleImage = String(
    profile.vehicleImage ?? profile.bikeImage ?? ''
  ).trim();
  const governorate = String(profile.governorate ?? '').trim();
  const district = String(profile.district ?? '').trim();
  const locality = String(profile.locality ?? profile.subArea ?? '').trim();
  return Boolean(
    name &&
      contactPhone &&
      homeAddress &&
      vehicleImage &&
      governorate &&
      district &&
      locality
  );
}

function isCourierApproved(profile) {
  return profile?.isApproved === true;
}

const COURIER_REJECTION_REASONS = {
  name: 'الاسم غير صحيح. يرجى إدخال الاسم الثلاثي (الاسم الأول + الأب + العائلة) بشكل واضح.',
  phone: 'رقم الهاتف غير صحيح. يرجى إدخال رقم مفعّل على واتساب.',
  address: 'عنوان السكن غير واضح أو غير مكتمل. يرجى تعديل العنوان.',
  vehicleImage: 'صورة الدراجة غير واضحة أو غير مقبولة. يرجى رفع صورة أوضح للدراجة.',
};

function courierApprovalStatus(profile) {
  if (!profile || typeof profile !== 'object') return 'pending';
  if (profile.isApproved === true || profile.approvalStatus === 'approved') {
    return 'approved';
  }
  const status = String(profile.approvalStatus ?? '').trim();
  if (status === 'rejected') return 'rejected';
  return 'pending';
}

function courierRejectionMessage(profile) {
  const explicit = String(profile?.rejectionMessageAr ?? '').trim();
  if (explicit) return explicit;
  const key = String(profile?.rejectionReasonKey ?? '').trim();
  return COURIER_REJECTION_REASONS[key] || '';
}

const OPERATOR_DOCUMENT_KEYS = [
  'profileImage',
  'vehicleImage',
  'carImage',
  'idFrontImage',
  'idBackImage',
  'residenceCardImage',
  'vehicleRegFrontImage',
  'vehicleRegBackImage',
];

function extractOperatorDocuments(profile) {
  if (!profile || typeof profile !== 'object') return undefined;
  const docs = {};
  let hasAny = false;
  for (const key of OPERATOR_DOCUMENT_KEYS) {
    const url = String(profile[key] ?? '').trim();
    if (url) {
      docs[key] = url;
      hasAny = true;
    }
  }
  const bikeImage = String(profile.bikeImage ?? '').trim();
  if (bikeImage && !docs.vehicleImage) {
    docs.vehicleImage = bikeImage;
    hasAny = true;
  }
  return hasAny ? docs : undefined;
}

function readDriverVehicleLabel(profile) {
  const rawVehicle = String(profile?.vehicle ?? '').trim();
  if (!rawVehicle || rawVehicle.startsWith('http')) return '';
  return rawVehicle;
}

function mapCourierForAdmin(phone, user, profile) {
  const name = String(profile.name ?? '').trim();
  const contactPhone = String(profile.phone ?? phone ?? '').trim();
  const homeAddress = String(
    profile.homeAddress ?? profile.address ?? profile.area ?? ''
  ).trim();
  const vehicleImage = String(
    profile.vehicleImage ?? profile.bikeImage ?? ''
  ).trim();

  return {
    phone: String(phone || '').trim(),
    name,
    contactPhone,
    homeAddress,
    vehicleImage,
    available: profile.available !== false && profile.isSuspended !== true,
    isSuspended: profile.isSuspended === true,
    isApproved: isCourierApproved(profile),
    approvalStatus: courierApprovalStatus(profile),
    rejectionReasonKey: String(profile.rejectionReasonKey ?? '').trim() || null,
    rejectionMessageAr: courierRejectionMessage(profile) || null,
    role: String(user?.role ?? '').trim(),
    accountType: String(user?.account_type ?? '').trim(),
    updatedAt: user?.updated_at ?? null,
    mukhtarName: String(profile.mukhtarName ?? '').trim(),
    rating: Number(profile.rating ?? 0),
    ratingCount: Number(profile.ratingCount ?? 0),
    documents: extractOperatorDocuments(profile),
    lastLat: Number(profile.lastLat ?? profile.latitude ?? profile.lat ?? 0) || null,
    lastLng: Number(profile.lastLng ?? profile.longitude ?? profile.lng ?? 0) || null,
    locationUpdatedAt: profile.locationUpdatedAt || profile.location_updated_at || null,
    mapsUrl: null,
  };
}

function readDriverProfileFromState(state) {
  if (!state || typeof state !== 'object') return null;
  const profile = state.driverProfile;
  if (!profile || typeof profile !== 'object') return null;
  return profile;
}

function isDriverProfileComplete(profile) {
  if (!profile || typeof profile !== 'object') return false;
  const name = String(profile.name ?? '').trim();
  const phone = String(profile.phone ?? '').trim();
  const vehicle = String(profile.vehicle ?? profile.carImage ?? '').trim();
  const plate = String(profile.plate ?? '').trim();
  const area = String(profile.area ?? profile.homeAddress ?? '').trim();
  const governorate = String(profile.governorate ?? '').trim();
  const district = String(profile.district ?? '').trim();
  const locality = String(profile.locality ?? profile.subArea ?? '').trim();
  return Boolean(
    name &&
      phone &&
      vehicle &&
      plate &&
      area &&
      governorate &&
      district &&
      locality
  );
}

function isDriverApproved(profile) {
  return profile?.isApproved === true;
}

function driverApprovalStatus(profile) {
  if (!profile || typeof profile !== 'object') return 'pending';
  if (isDriverApproved(profile)) return 'approved';
  if (String(profile.approvalStatus ?? '').trim() === 'rejected') return 'rejected';
  return 'pending';
}

function driverRejectionMessage(profile) {
  return String(profile?.rejectionMessageAr ?? '').trim();
}

function mapDriverForAdmin(phone, user, profile) {
  const name = String(profile.name ?? '').trim();
  const contactPhone = String(profile.phone ?? phone ?? '').trim();
  const vehicle = readDriverVehicleLabel(profile);
  const plate = String(profile.plate ?? '').trim();
  const area = String(profile.area ?? profile.homeAddress ?? '').trim();
  const carImage = String(profile.carImage ?? '').trim();

  return {
    phone: String(phone || '').trim(),
    name,
    contactPhone,
    vehicle,
    plate,
    area,
    carImage,
    taxiType: String(
      profile.taxiType ||
        (['economic', 'starx11', 'tuktuk', 'wazz'].includes(
          String(profile.type || '').trim().toLowerCase(),
        )
          ? profile.type
          : 'economic'),
    ).trim(),
    mukhtarName: String(profile.mukhtarName ?? '').trim(),
    available: profile.available !== false && profile.isSuspended !== true,
    isSuspended: profile.isSuspended === true,
    isApproved: isDriverApproved(profile),
    approvalStatus: driverApprovalStatus(profile),
    rejectionReasonKey: String(profile.rejectionReasonKey ?? '').trim() || null,
    rejectionMessageAr: profile.rejectionMessageAr || null,
    role: String(user?.role ?? '').trim(),
    accountType: String(user?.account_type ?? '').trim(),
    updatedAt: user?.updated_at ?? null,
    documents: extractOperatorDocuments(profile),
    lastLat: Number(profile.lastLat ?? profile.latitude ?? profile.lat ?? 0) || null,
    lastLng: Number(profile.lastLng ?? profile.longitude ?? profile.lng ?? 0) || null,
    locationUpdatedAt: profile.locationUpdatedAt || profile.location_updated_at || null,
    mapsUrl: null,
  };
}

module.exports = {
  readCourierProfileFromState,
  isCourierProfileComplete,
  isCourierApproved,
  COURIER_REJECTION_REASONS,
  courierApprovalStatus,
  courierRejectionMessage,
  mapCourierForAdmin,
  readDriverProfileFromState,
  isDriverProfileComplete,
  isDriverApproved,
  driverApprovalStatus,
  driverRejectionMessage,
  mapDriverForAdmin,
};
