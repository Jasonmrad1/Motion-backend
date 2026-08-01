function normalizeValue(value) {
  if (value == null) return '';
  return value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeValue(item))
      .filter(Boolean);
  }
  return value
    .toString()
    .split(',')
    .map((item) => normalizeValue(item))
    .filter(Boolean);
}

const MUSCLE_SYNONYM_GROUPS = {
  abdominals: ['core', 'abs', 'abdominal', 'abdominals', 'midsection', 'waist', 'lower abs', 'upper abs', 'six pack'],
  back: ['back', 'lats', 'upper back', 'lat', 'wings', 'rear delts'],
  chest: ['chest', 'pecs', 'pectorals', 'pectoralis'],
  shoulders: ['shoulders', 'delts', 'deltoids'],
  biceps: ['biceps', 'arms'],
  triceps: ['triceps', 'arms'],
  forearms: ['forearms'],
  trapezius: ['traps', 'trapezius'],
  quads: ['quads', 'quadriceps', 'thighs'],
  hamstrings: ['hamstrings'],
  glutes: ['glutes', 'gluteus'],
  calves: ['calves'],
};

const MUSCLE_CANONICAL_TO_GROUP_NAME = {
  abdominals: 'Abdominals',
  back: 'Back',
  chest: 'Chest',
  shoulders: 'Shoulders',
  biceps: 'Biceps',
  triceps: 'Triceps',
  forearms: 'Forearms',
  trapezius: 'Trapezius',
  quads: 'Quads',
  hamstrings: 'Hamstrings',
  glutes: 'Glutes',
  calves: 'Calves',
};

const MUSCLE_SYNONYMS = Object.fromEntries(
  Object.entries(MUSCLE_SYNONYM_GROUPS).flatMap(([canonical, terms]) =>
    terms.map((term) => [normalizeValue(term), canonical])
  )
);

function normalizeMuscle(value) {
  const normalized = normalizeValue(value);
  return MUSCLE_SYNONYMS[normalized] || normalized;
}

function resolveMuscleGroupLabel(value) {
  if (!value) return '';
  const normalized = normalizeValue(value);
  if (MUSCLE_CANONICAL_TO_GROUP_NAME[normalized]) {
    return MUSCLE_CANONICAL_TO_GROUP_NAME[normalized];
  }

  const canonical = MUSCLE_SYNONYMS[normalized];
  if (canonical && MUSCLE_CANONICAL_TO_GROUP_NAME[canonical]) {
    return MUSCLE_CANONICAL_TO_GROUP_NAME[canonical];
  }

  return value.toString().trim();
}

function inferMuscleGroupsFromText(text) {
  if (!text) return [];
  const normalized = normalizeValue(text);
  const groups = new Set();

  for (const [term, canonical] of Object.entries(MUSCLE_SYNONYMS)) {
    if (normalized.includes(term)) {
      groups.add(canonical);
    }
  }

  return Array.from(groups);
}

module.exports = {
  normalizeValue,
  normalizeArray,
  normalizeMuscle,
  inferMuscleGroupsFromText,
  resolveMuscleGroupLabel,
  MUSCLE_SYNONYM_GROUPS,
  MUSCLE_CANONICAL_TO_GROUP_NAME,
};
