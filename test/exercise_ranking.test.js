const test = require('node:test');
const assert = require('node:assert');
const { rankExercises } = require('../services/exerciseRankingService');
const {
  normalizeValue,
  normalizeArray,
  normalizeMuscle,
  inferMuscleGroupsFromText,
  resolveMuscleGroupLabel,
} = require('../services/muscleNormalizationService');

test('Muscle Normalization - Synonyms and Canonical Mapping', async (t) => {
  await t.test('resolves muscle synonyms to canonical group names', () => {
    assert.strictEqual(resolveMuscleGroupLabel('lats'), 'Back');
    assert.strictEqual(resolveMuscleGroupLabel('quadriceps'), 'Quads');
    assert.strictEqual(resolveMuscleGroupLabel('pectoralis'), 'Chest');
    assert.strictEqual(resolveMuscleGroupLabel('abs'), 'Abdominals');
    assert.strictEqual(resolveMuscleGroupLabel('deltoids'), 'Shoulders');
  });

  await t.test('infers muscle groups accurately from user message text', () => {
    const text = "I want a brutal chest and triceps workout with dumbells";
    const inferred = inferMuscleGroupsFromText(text);
    assert.ok(inferred.includes('chest'));
    assert.ok(inferred.includes('triceps'));
  });
});

test('Exercise Ranking - Equipment Filtering & Penalties', async (t) => {
  const sampleExercises = [
    {
      name: 'Barbell Bench Press',
      target: 'chest',
      bodyPart: 'chest',
      equipment: 'barbell',
      difficulty: 'intermediate',
      card_category: 'compound',
    },
    {
      name: 'Dumbbell Bench Press',
      target: 'chest',
      bodyPart: 'chest',
      equipment: 'dumbbell',
      difficulty: 'intermediate',
      card_category: 'compound',
    },
    {
      name: 'Push Up',
      target: 'chest',
      bodyPart: 'chest',
      equipment: 'body weight',
      difficulty: 'beginner',
      card_category: 'bodyweight',
    },
  ];

  await t.test('penalizes unavailable equipment heavily', () => {
    const result = rankExercises({
      exercises: sampleExercises,
      targetMuscles: ['Chest'],
      availableEquipment: ['dumbbell', 'body weight'], // No barbell!
      experienceLevel: 'intermediate',
    });

    const topExerciseNames = result.topExercises.map((e) => e.name);
    assert.ok(topExerciseNames.includes('Dumbbell Bench Press'));
    assert.ok(topExerciseNames.includes('Push Up'));
    // Barbell Bench Press should either be ranked last or penalized with negative score
    const barbellPress = result.rankedExercises.find((e) => e.name === 'Barbell Bench Press');
    assert.ok(barbellPress.score < 0, 'Barbell press should receive heavy negative score penalty when barbell is unavailable');
  });
});

test('Exercise Ranking - Family Diversity & Anti-Repetition', async (t) => {
  const duplicateFamilyExercises = [
    { name: 'Lat Pulldown Wide Grip', target: 'lats', equipment: 'cable', difficulty: 'intermediate' },
    { name: 'Lat Pulldown Close Grip', target: 'lats', equipment: 'cable', difficulty: 'intermediate' },
    { name: 'Lat Pulldown V-Bar', target: 'lats', equipment: 'cable', difficulty: 'intermediate' },
    { name: 'Barbell Bent Over Row', target: 'lats', equipment: 'barbell', difficulty: 'intermediate' },
  ];

  await t.test('penalizes redundant exercise families in candidate pool', () => {
    const result = rankExercises({
      exercises: duplicateFamilyExercises,
      targetMuscles: ['Back'],
      availableEquipment: ['cable', 'barbell'],
      experienceLevel: 'intermediate',
    });

    // The first lat pulldown should be top ranked, but subsequent ones should carry family penalties
    const pulldowns = result.rankedExercises.filter((e) => e.family === 'pulldown');
    assert.ok(pulldowns.length > 0);
    assert.ok(pulldowns[0].score > pulldowns[1].score, 'Second pulldown should have reduced score due to family penalty');
  });
});

test('Exercise Ranking - Difficulty Scaling by Experience Level', async (t) => {
  const exerciseSet = [
    { name: 'Wall Push Up', target: 'chest', equipment: 'body weight', difficulty: 'beginner' },
    { name: 'Ring Flyes', target: 'chest', equipment: 'body weight', difficulty: 'advanced' },
  ];

  await t.test('prefers beginner exercises for beginner users', () => {
    const result = rankExercises({
      exercises: exerciseSet,
      targetMuscles: ['Chest'],
      availableEquipment: ['body weight'],
      experienceLevel: 'beginner',
    });

    assert.strictEqual(result.topExercises[0].name, 'Wall Push Up');
  });

  await t.test('prefers advanced exercises for advanced users', () => {
    const result = rankExercises({
      exercises: exerciseSet,
      targetMuscles: ['Chest'],
      availableEquipment: ['body weight'],
      experienceLevel: 'advanced',
    });

    assert.strictEqual(result.topExercises[0].name, 'Ring Flyes');
  });
});
