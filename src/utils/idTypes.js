export const ID_TYPES = [
  'Birth Certificate',
  'National ID',
  'National ID Card',
  'Student ID',
  'Other',
];

// True if the value is an allowed ID document type. Used when creating or
// updating students, teachers, and guardians.
export const isValidIdType = (value) => ID_TYPES.includes(value);

// Passports have one side only. Other ID types require a back photo on create/update.
export const needsIdBack = (idType) =>
  Boolean(idType) && idType !== 'Passport' && idType !== 'Birth Certificate';

// Maps older ID type values onto the current labels.
export const normalizeIdType = (value = '') => {
  const raw = String(value).trim();
  if (!raw) return '';
  if (ID_TYPES.includes(raw)) return raw;

  const legacy = {
    passport: 'Passport',
    drivers_license: "Driver's License",
    "driver's_license": "Driver's License",
    "driver's license": "Driver's License",
    'driver license': 'Driver License',
    ghana_card: 'National ID',
    national_id: 'National ID',
    'national id': 'National ID',
    'national id card': 'National ID Card',
    'birth certificate': 'Birth Certificate',
    'student id': 'Student ID',
    'voter id': 'Voter ID',
    other: 'Other',
  };
  return legacy[raw.toLowerCase()] || 'Other';
};
