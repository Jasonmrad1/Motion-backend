const {
  normalizeValue,
  normalizeArray,
  normalizeMuscle,
} = require('./muscleNormalizationService');

function getDifficultyScore(experienceLevel, exerciseDifficulty) {
  const difficulty = normalizeValue(exerciseDifficulty);
  const level = normalizeValue(experienceLevel) || 'intermediate';

  if (level === 'beginner') {
    if (difficulty === 'beginner') return 30;
    if (difficulty === 'intermediate') return 10;
    if (difficulty === 'advanced') return -50;
  }

  if (level === 'intermediate') {
    if (difficulty === 'beginner') return 10;
    if (difficulty === 'intermediate') return 30;
    if (difficulty === 'advanced') return 10;
  }

  if (level === 'advanced') {
    if (difficulty === 'beginner') return 5;
    if (difficulty === 'intermediate') return 15;
    if (difficulty === 'advanced') return 30;
  }

  return 0;
}

function isCompoundExercise(cardCategory) {
  if (!cardCategory) return false;
  const normalized = normalizeValue(cardCategory);
  const compoundIndicators = [
    'compound',
    'barbell',
    'dumbbell',
    'kettlebell',
    'olympic',
    'multi',
    'strength',
  ];
  return compoundIndicators.some((term) => normalized.includes(term));
}

const EXERCISE_FAMILIES = [
  { family: 'pulldown', keywords: ['pulldown', 'lat pulldown'] },
  { family: 'row', keywords: ['row', 'rows'] },
  { family: 'pullup', keywords: ['pullup', 'pull ups', 'chin up', 'chin-up'] },
  { family: 'bench_press', keywords: ['bench press'] },
  { family: 'chest_press', keywords: ['chest press', 'machine press'] },
  { family: 'shoulder_press', keywords: ['shoulder press', 'overhead press', 'military press'] },
  { family: 'squat', keywords: ['squat'] },
  { family: 'deadlift', keywords: ['deadlift', 'romanian deadlift', 'sumo deadlift'] },
  { family: 'lunge', keywords: ['lunge'] },
  { family: 'curl', keywords: ['curl'] },
  { family: 'tricep_extension', keywords: ['tricep extension', 'triceps extension', 'skullcrusher', 'skull crusher'] },
  { family: 'fly', keywords: ['fly', 'flies'] },
  { family: 'lateral_raise', keywords: ['lateral raise'] },
  { family: 'rear_delt', keywords: ['rear delt', 'reverse fly', 'rear fly', 'face pull'] },
  { family: 'calf_raise', keywords: ['calf raise'] },
];

function detectExerciseFamily(name) {
  const normalized = normalizeValue(name);
  for (const entry of EXERCISE_FAMILIES) {
    for (const keyword of entry.keywords) {
      if (normalized.includes(keyword)) {
        return entry.family;
      }
    }
  }
  return 'other';
}

function stringSimilarity(a, b) {
  const aWords = normalizeValue(a).split(' ').filter(Boolean);
  const bWords = normalizeValue(b).split(' ').filter(Boolean);
  if (!aWords.length || !bWords.length) return 0;

  const intersection = aWords.filter((word) => bWords.includes(word)).length;
  const union = new Set([...aWords, ...bWords]).size;
  return union === 0 ? 0 : intersection / union;
}

function scoreExercise(exercise, targetMuscles, availableEquipment, experienceLevel, fitnessGoal, userMessage = '') {
  let score = 0;
  const normalizedTarget = normalizeMuscle(exercise.target);
  const normalizedBodyPart = normalizeMuscle(exercise.bodyPart);
  const normalizedSecondary = normalizeArray(exercise.secondaryMuscles).map(normalizeMuscle);
  const normalizedEquipment = normalizeValue(exercise.equipment);
  const normalizedCategory = normalizeValue(exercise.category);
  const normalizedCardCategory = normalizeValue(exercise.exercise_card_category || exercise.cardCategory || exercise.card_category);
  const normalizedName = normalizeValue(exercise.name);
  const normalizedMessage = normalizeValue(userMessage);

  const targetSet = new Set(targetMuscles.map(normalizeMuscle).filter(Boolean));

  if (targetSet.has(normalizedTarget)) {
    score += 100;
  }

  if (targetSet.has(normalizedBodyPart) && normalizedBodyPart !== normalizedTarget) {
    score += 80;
  }

  if (normalizedSecondary.some((secondary) => targetSet.has(secondary))) {
    score += 40;
  }

  if (normalizedMessage && normalizedName && normalizedMessage.includes(normalizedName)) {
    score += 60;
  }

  if (availableEquipment.includes(normalizedEquipment)) {
    score += 50;
  } else {
    score -= 1000;
  }

  score += getDifficultyScore(experienceLevel, exercise.difficulty);

  if (normalizeValue(fitnessGoal) === 'hypertrophy' && normalizedCategory === 'strength') {
    score += 20;
  }

  if (normalizeValue(fitnessGoal) === 'strength' && isCompoundExercise(normalizedCardCategory)) {
    score += 20;
  }

  return score;
}

function buildCandidatePool(scored, maxCount = 20) {
  const selected = [];
  const remaining = scored.map((entry) => ({ ...entry }));

  while (selected.length < maxCount && remaining.length) {
    for (const item of remaining) {
      let penalty = 0;
      const penaltyEntries = [];

      for (const chosen of selected) {
        const sameFamily = item.family && chosen.family && item.family !== 'other' && item.family === chosen.family;
        const sameTarget = normalizeMuscle(item.exercise.target) === normalizeMuscle(chosen.exercise.target);
        const sameEquipment = normalizeValue(item.exercise.equipment) === normalizeValue(chosen.exercise.equipment);
        const similarity = stringSimilarity(item.exercise.name, chosen.exercise.name);

        if (sameFamily) {
          penalty += 100;
          penaltyEntries.push({ reason: 'same_family', amount: 100, comparedWith: chosen.exercise.name });
        }
        if (sameTarget && sameEquipment && similarity > 0.5) {
          penalty += 120;
          penaltyEntries.push({ reason: 'same_target_equipment_similar_name', amount: 120, comparedWith: chosen.exercise.name, similarity });
        }
      }

      item.adjustedScore = item.baseScore - penalty;
      item.penaltyDetails = penaltyEntries;
    }

    remaining.sort((a, b) => {
      if (b.adjustedScore !== a.adjustedScore) return b.adjustedScore - a.adjustedScore;
      return normalizeValue(a.exercise.name).localeCompare(normalizeValue(b.exercise.name));
    });

    const next = remaining.shift();
    if (!next) break;

    console.log('Exercise candidate:', JSON.stringify({
      name: next.exercise.name,
      score: next.baseScore,
      family: next.family,
      penalties: next.penaltyDetails,
      adjustedScore: next.adjustedScore,
    }));

    selected.push(next);
  }

  return selected;
}

function rankExercises({
  exercises,
  targetMuscles = [],
  availableEquipment = [],
  experienceLevel = 'intermediate',
  fitnessGoal = '',
  userMessage = '',
}) {
  const normalizedEquipment = normalizeArray(availableEquipment);
  const normalizedTargets = normalizeArray(targetMuscles);

  const scored = exercises
    .map((exercise) => {
      const baseScore = scoreExercise(
        exercise,
        normalizedTargets,
        normalizedEquipment,
        experienceLevel,
        fitnessGoal,
        userMessage
      );
      const family = detectExerciseFamily(exercise.name || '');
      return {
        exercise,
        baseScore,
        family,
        adjustedScore: baseScore,
        penaltyDetails: [],
      };
    })
    .filter((entry) => Number.isFinite(entry.baseScore));

  scored.sort((a, b) => {
    if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
    return normalizeValue(a.exercise.name).localeCompare(normalizeValue(b.exercise.name));
  });

  const rankedExercises = buildCandidatePool(scored, 20).map((entry) => ({
    ...entry.exercise,
    score: entry.adjustedScore,
    family: entry.family,
    penalties: entry.penaltyDetails,
  }));

  return {
    rankedExercises,
    topExercises: rankedExercises.slice(0, 20),
  };
}

module.exports = {
  rankExercises,
};
