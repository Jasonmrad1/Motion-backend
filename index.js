const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fetch = require("node-fetch"); // or use axios
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Firebase admin
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Constants for AI bot
const BOT_USER_ID = 'ai-bot-fitness-coach';
const DEFAULT_ALLOWED_EXERCISE_LIMIT = 80;

const MUSCLE_GROUP_TO_TARGETS = {
  Back: ['upper back', 'lats', 'levator scapulae', 'serratus anterior', 'spine', 'back'],
  Chest: ['pectorals', 'chest'],
  Biceps: ['biceps'],
  Triceps: ['triceps'],
  Forearms: ['forearms'],
  Shoulders: ['delts', 'shoulders'],
  Trapezius: ['traps', 'trapezius'],
  Quads: ['quads', 'adductors', 'quadriceps'],
  Hamstrings: ['hamstrings'],
  Glutes: ['glutes', 'gluteus'],
  Calves: ['calves'],
  Abdominals: ['abs', 'abdominals', 'core'],
};

function normalizeToArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => item?.toString().trim()).filter(Boolean);
  return value.toString().split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeWorkoutFilters(filters = {}) {
  const muscleGroups = normalizeToArray(filters.muscleGroups);
  const equipment = normalizeToArray(filters.equipment);
  const difficulty = normalizeToArray(filters.difficulty);
  const workoutType = normalizeToArray(filters.workoutType);
  const goal = filters.goal?.toString().trim() || '';
  const userMessage = filters.userMessage?.toString().trim().toLowerCase() || '';

  const categories = new Set();
  const cardCategories = new Set();

  const addCategory = (value) => {
    if (!value) return;
    const normalized = value.toString().trim().toLowerCase();
    if (normalized.includes('calisthenics')) categories.add('calisthenics');
    if (normalized.includes('bodyweight')) categories.add('bodyweight');
    if (normalized.includes('assisted')) categories.add('assisted');
    if (normalized.includes('mobility')) categories.add('mobility');
    if (normalized.includes('power')) categories.add('power');
    if (normalized.includes('strength')) categories.add('strength');
  };

  const addCardCategory = (value) => {
    if (!value) return;
    const normalized = value.toString().trim().toLowerCase();
    if (normalized.includes('assisted')) cardCategories.add('BW_ASSISTED');
    if (normalized.includes('weighted')) cardCategories.add('BW_WEIGHTED');
    if (normalized.includes('bodyweight')) {
      cardCategories.add('BW');
      cardCategories.add('BW_ASSISTED');
      cardCategories.add('BW_WEIGHTED');
    }
    if (normalized.includes('calisthenics')) {
      cardCategories.add('BW');
      cardCategories.add('BW_ASSISTED');
      cardCategories.add('BW_WEIGHTED');
    }
    if (normalized.includes('timed')) cardCategories.add('BW_TIMED');
    if (normalized.includes('time')) cardCategories.add('TIMED');
  };

  equipment.forEach(addCategory);
  difficulty.forEach(addCategory);
  workoutType.forEach(addCategory);
  normalizeToArray(goal).forEach(addCategory);
  normalizeToArray(userMessage).forEach(addCategory);

  equipment.forEach(addCardCategory);
  difficulty.forEach(addCardCategory);
  workoutType.forEach(addCardCategory);
  normalizeToArray(goal).forEach(addCardCategory);
  normalizeToArray(userMessage).forEach(addCardCategory);

  if (difficulty.some((value) => value.toLowerCase().includes('assisted'))) {
    cardCategories.add('BW_ASSISTED');
  }
  if (equipment.some((value) => value.toLowerCase().includes('calisthenics'))) {
    categories.add('calisthenics');
  }
  if (userMessage.includes('assisted calisthenics')) {
    categories.add('calisthenics');
    cardCategories.add('BW_ASSISTED');
  }

  return {
    muscleGroups,
    equipment,
    difficulty,
    workoutType,
    categories: [...categories],
    cardCategories: [...cardCategories],
    avoidCardCategories: ['TIMED', 'BW_TIMED'],
  };
}

function expandMuscleGroupFilters(muscleGroups) {
  const expanded = [];
  for (const group of muscleGroups) {
    const normalizedGroup = group?.toString().trim();
    if (!normalizedGroup) continue;
    expanded.push(normalizedGroup);
    const mappedKey = Object.keys(MUSCLE_GROUP_TO_TARGETS).find(
      (key) => key.toLowerCase() === normalizedGroup.toLowerCase()
    );
    if (mappedKey) {
      expanded.push(...MUSCLE_GROUP_TO_TARGETS[mappedKey]);
    }
  }
  return [...new Set(expanded.map((value) => value.toString().toLowerCase()))];
}

function normalizeExerciseBodyPart(rawBodyPart, rawTarget, secondaryMuscles = []) {
  const values = [rawBodyPart, rawTarget, ...(Array.isArray(secondaryMuscles) ? secondaryMuscles : [secondaryMuscles])]
    .filter(Boolean)
    .map((value) => value.toString().toLowerCase());

  for (const [group, terms] of Object.entries(MUSCLE_GROUP_TO_TARGETS)) {
    if (values.some((value) => value === group.toLowerCase())) {
      return group;
    }

    if (values.some((value) => terms.some((term) => value.includes(term)))) {
      return group;
    }
  }

  return rawBodyPart || rawTarget || 'General';
}

function normalizeSearchText(value) {
  if (!value) return '';
  return value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findExplicitExerciseMatches(userMessage, exercises) {
  const normalizedMessage = normalizeSearchText(userMessage);
  if (!normalizedMessage || !Array.isArray(exercises)) return [];

  return exercises.filter((exercise) => {
    const normalizedName = normalizeSearchText(exercise.name);
    if (!normalizedName) return false;
    if (normalizedMessage.includes(normalizedName)) return true;

    const compactMessage = normalizedMessage.replace(/\s+/g, '');
    const compactName = normalizedName.replace(/\s+/g, '');
    return compactName && compactMessage.includes(compactName);
  });
}

function matchesFilterValue(cellValue, filterValues) {
  if (!filterValues?.length) return true;
  if (!cellValue) return false;
  const normalizedCell = cellValue.toString().toLowerCase();
  return filterValues.some((filter) => normalizedCell.includes(filter.toString().toLowerCase()));
}

function calculateExpectedTime(exercises) {
  if (!Array.isArray(exercises) || exercises.length === 0) return 0;

  let totalTimeSec = 0;

  for (const exercise of exercises) {
    const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
    const setsCount = sets.length || 3;

    let totalReps = 0;
    for (const set of sets) {
      const reps = Number(set?.reps ?? 10) || 10;
      totalReps += reps;
    }
    if (totalReps === 0) totalReps = setsCount * 10;

    const diff = (exercise.difficulty ?? 'easy').toString().toLowerCase();
    let exerciseTime = Math.round(totalReps * 2.5);

    let restTimePerSet;
    switch (diff) {
      case 'hard':
        restTimePerSet = 75;
        break;
      case 'intermediate':
        restTimePerSet = 60;
        break;
      default:
        restTimePerSet = 45;
    }

    exerciseTime += (setsCount - 1) * restTimePerSet;
    totalTimeSec += exerciseTime;
  }

  totalTimeSec += 120;
  return Math.round(totalTimeSec / 60);
}

function calculateDifficulty(exercises) {
  if (!Array.isArray(exercises) || exercises.length === 0) return 'Easy';

  let totalScore = 0;

  for (const exercise of exercises) {
    const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
    const setsCount = sets.length || 3;

    let exerciseIntensity = 0;
    for (const set of sets) {
      const reps = Number(set?.reps ?? 10) || 10;
      const weight = Number(set?.kg ?? 0) || 0;
      if (reps > 0 && weight > 0) {
        exerciseIntensity += weight * (12 / reps);
      } else {
        exerciseIntensity += reps * 0.5;
      }
    }

    const diff = (exercise.difficulty ?? 'easy').toString().toLowerCase();
    let difficultyMultiplier;
    switch (diff) {
      case 'hard':
        difficultyMultiplier = 2.0;
        break;
      case 'intermediate':
        difficultyMultiplier = 1.5;
        break;
      default:
        difficultyMultiplier = 1.0;
    }

    totalScore += setsCount * exerciseIntensity * difficultyMultiplier;
  }

  const normalizedScore = totalScore / exercises.length;
  if (normalizedScore < 20) return 'Easy';
  if (normalizedScore < 50) return 'Medium';
  if (normalizedScore < 100) return 'Hard';
  return 'Advanced';
}

async function fetchCandidateExercises(filters = {}, userMessage = '') {
  const {
    muscleGroups = [],
    equipment = [],
    difficulty = [],
    workoutType = [],
    categories = [],
    cardCategories = [],
    avoidCardCategories = ['TIMED', 'BW_TIMED'],
  } = filters;
  const effectiveMuscleGroups = expandMuscleGroupFilters(muscleGroups);

  const { data: exercises, error } = await supabase
    .from('exercises')
    .select('*')
    .limit(DEFAULT_ALLOWED_EXERCISE_LIMIT * 5);

  if (error) {
    throw new Error(`Failed to load exercise candidates: ${error.message || error}`);
  }

  if (!Array.isArray(exercises) || exercises.length === 0) {
    return [];
  }

  const normalizedExercises = exercises
    .map((exercise) => {
      const secondaryMuscles = Array.isArray(exercise.secondaryMuscles)
        ? exercise.secondaryMuscles.map((m) => String(m))
        : exercise.secondaryMuscles != null
        ? [String(exercise.secondaryMuscles)]
        : [];

      const rawBodyPart = exercise.bodyPart || exercise.body_part || exercise.target || 'General';
      const rawTarget = exercise.target || '';

      return {
        id: Number(exercise.id),
        name: (exercise.name || exercise.exercise || '').toString().trim(),
        bodyPart: normalizeExerciseBodyPart(rawBodyPart, rawTarget, secondaryMuscles),
        target: rawTarget,
        equipment: exercise.equipment || '',
        difficulty: exercise.difficulty || '',
        workoutType: exercise.workout_type || exercise.workoutType || exercise.type || '',
        category: exercise.category || '',
        cardCategory: exercise.exercise_card_category || exercise.exerciseCardCategory || 'NORMAL',
        secondaryMuscles,
        gifUrl: exercise.gifUrl || '',
      };
    })
    .filter((exercise) => exercise.id && exercise.name);

  const explicitRequestedExercises = findExplicitExerciseMatches(userMessage, normalizedExercises);
  const explicitExerciseIds = new Set(explicitRequestedExercises.map((exercise) => exercise.id));

  const matchesCardCategory = (cardCategoryValue) => {
    if (!cardCategories.length) return true;
    const normalizedCard = cardCategoryValue?.toString().trim().toLowerCase();
    return cardCategories.some((filter) => {
      const normalizedFilter = filter.toString().trim().toLowerCase();
      if (normalizedFilter === 'bw') {
        return normalizedCard === 'bw' || normalizedCard.startsWith('bw_');
      }
      if (normalizedFilter === 'timed') {
        return normalizedCard === 'timed' || normalizedCard === 'bw_timed';
      }
      return normalizedFilter === normalizedCard;
    });
  };

  const filteredExercises = normalizedExercises.filter((exercise) => {
    if (avoidCardCategories.length && exercise.cardCategory) {
      if (avoidCardCategories.some((filter) => exercise.cardCategory.toString().trim().toLowerCase() === filter.toString().trim().toLowerCase())) {
        return false;
      }
    }

    if (effectiveMuscleGroups.length) {
      const muscleMatch = [exercise.bodyPart, exercise.target]
        .filter(Boolean)
        .some((field) => matchesFilterValue(field, effectiveMuscleGroups));
      const secondaryMatch = exercise.secondaryMuscles.some((muscle) => matchesFilterValue(muscle, effectiveMuscleGroups));
      if (!muscleMatch && !secondaryMatch) return false;
    }

    if (categories.length && !matchesFilterValue(exercise.category, categories)) {
      return false;
    }

    if (equipment.length && !matchesFilterValue(exercise.equipment, equipment)) {
      return false;
    }
    if (difficulty.length && exercise.difficulty) {
      if (!matchesFilterValue(exercise.difficulty, difficulty)) return false;
    }
    if (workoutType.length && exercise.workoutType) {
      if (!matchesFilterValue(exercise.workoutType, workoutType)) return false;
    }
    if (cardCategories.length && !matchesCardCategory(exercise.cardCategory)) {
      return false;
    }

    return true;
  });

  if (filteredExercises.length) {
    const explicitOnly = explicitRequestedExercises.filter((exercise) => !filteredExercises.some((item) => item.id === exercise.id));
    const ordered = [...explicitRequestedExercises, ...filteredExercises.filter((exercise) => !explicitExerciseIds.has(exercise.id))];
    return ordered.slice(0, DEFAULT_ALLOWED_EXERCISE_LIMIT);
  }

  console.warn('⚠️ No exercises matched strict filters, relaxing filter rules', {
    muscleGroups,
    equipment,
    difficulty,
    workoutType,
    categories,
    cardCategories,
  });

  const relaxedExercises = normalizedExercises.filter((exercise) => {
    if (avoidCardCategories.length && exercise.cardCategory) {
      if (avoidCardCategories.some((filter) => exercise.cardCategory.toString().trim().toLowerCase() === filter.toString().trim().toLowerCase())) {
        return false;
      }
    }

    if (effectiveMuscleGroups.length) {
      const muscleMatch = [exercise.bodyPart, exercise.target]
        .filter(Boolean)
        .some((field) => matchesFilterValue(field, effectiveMuscleGroups));
      const secondaryMatch = exercise.secondaryMuscles.some((muscle) => matchesFilterValue(muscle, effectiveMuscleGroups));
      if (!muscleMatch && !secondaryMatch) return false;
    }

    if (categories.length && matchesFilterValue(exercise.category, categories)) {
      return true;
    }

    if (equipment.length && matchesFilterValue(exercise.equipment, equipment)) {
      return true;
    }

    if (difficulty.length && exercise.difficulty && matchesFilterValue(exercise.difficulty, difficulty)) {
      return true;
    }

    if (workoutType.length && exercise.workoutType && matchesFilterValue(exercise.workoutType, workoutType)) {
      return true;
    }

    if (cardCategories.length && matchesCardCategory(exercise.cardCategory)) {
      return true;
    }

    return !categories.length && !equipment.length && !difficulty.length && !workoutType.length && !cardCategories.length;
  });

  const finalCandidates = relaxedExercises.length
    ? relaxedExercises
    : normalizedExercises;

  const orderedFinalCandidates = [
    ...explicitRequestedExercises,
    ...finalCandidates.filter((exercise) => !explicitExerciseIds.has(exercise.id)),
  ];

  if (!orderedFinalCandidates.length) {
    return [];
  }

  return orderedFinalCandidates.slice(0, DEFAULT_ALLOWED_EXERCISE_LIMIT);
}

function buildAllowedExercisesPrompt(userMessage, allowedExercises, filters = {}, userBodyweightKg = null) {
  const exerciseList = allowedExercises
    .map((exercise) => {
      const secondary = exercise.secondaryMuscles?.length ? exercise.secondaryMuscles.join(', ') : 'None';
      return `- ID ${exercise.id}: ${exercise.name} | bodyPart: ${exercise.bodyPart || 'Unknown'} | equipment: ${exercise.equipment || 'None'} | target: ${exercise.target || 'None'} | secondaryMuscles: ${secondary} | difficulty: ${exercise.difficulty || 'Unknown'} | workoutType: ${exercise.workoutType || 'General'} | category: ${exercise.category || 'General'} | cardCategory: ${exercise.cardCategory || 'NORMAL'}`;
    })
    .join('\n');

  const preferenceFragments = [];
  if (filters.muscleGroups?.length) preferenceFragments.push(`Muscle groups: ${filters.muscleGroups.join(', ')}`);
  if (filters.equipment?.length) preferenceFragments.push(`Equipment: ${filters.equipment.join(', ')}`);
  if (filters.difficulty?.length) preferenceFragments.push(`Difficulty: ${filters.difficulty.join(', ')}`);
  if (filters.workoutType?.length) preferenceFragments.push(`Workout type: ${filters.workoutType.join(', ')}`);

  const preferenceText = preferenceFragments.length
    ? `User preferences:\n${preferenceFragments.join('\n')}`
    : 'No explicit additional preferences were provided.';

  const bodyweightNote = userBodyweightKg
    ? `\nUser bodyweight: ${userBodyweightKg} kg. For bodyweight related exercises, return the actual stored load in kg: use the user's bodyweight for BW exercises, the total final load for BW_WEIGHTED exercises (bodyweight + added weight), and the actual reduced load for BW_ASSISTED exercises (bodyweight - assistance). Choose realistic weights based on the user's bodyweight.`
    : '';

  return `Based on this request: "${userMessage}"
${preferenceText}${bodyweightNote}

You are a professional fitness coach. From the exercise candidate list below, select the best exercises and build a workout routine like a real coach.
If the user specifically requests a named exercise, prefer that exercise from the allowed candidate list.
Use only exercises from the candidate list. Do not invent, rename, substitute, or use any exercise that is not present.

Design a balanced routine that fits the user's goal and constraints. Use 4-8 unique exercises. Choose the appropriate sets, reps, and notes for each exercise.
Give the routine a meaningful title that reflects the user's request or the workout focus.

Return only valid JSON in this exact format:
{
  "title": "string",
  "exercises": [
    {
      "exercise_id": number,
      "notes": ["string"],
      "sets": [
        { "kg": number, "reps": number }
      ]
    }
  ]
}

Exercise candidates:
${exerciseList}

Important:
- Do not select exercises with category BW_TIMED or TIMED because the app does not currently implement a timer.
- Prefer BW_ASSISTED for assisted calisthenics-style exercises when the user request mentions assistance.
- Choose realistic weights relative to the user's bodyweight and the exercise category.
- For BW_WEIGHTED exercises, the kg value must be the total final load after added weight. The added weight should be a moderate percentage of bodyweight, not an extreme or impossible load.
- For BW_ASSISTED exercises, the kg value must be the actual assisted load after subtraction. The result should be a realistic reduced load, typically between 30% and 90% of bodyweight for assisted progressions.
- For pure BW exercises, use the user's exact bodyweight as the load.
- Do not return unrealistic values such as 0 kg, 1000 kg, or negative loads.
- Only use the keys shown above.
- Use only exercise_id, notes, and sets for each exercise.
- Use only kg and reps for each set.
- For bodyweight, assisted, and weighted-bodyweight exercises, do NOT include BW, BW +, BW -, or any display-formatted weight text in the JSON.
- Do not include any other fields such as name, bodyPart, gifUrl, difficulty, rest_seconds, restSeconds, weight, or workout_type.
- Do not use exercise-level reps or set counts.
- Do not include markdown, comments, or extra text.
`;
}

async function fetchLatestUserRoutine(userUuid) {
  if (!userUuid) return null;

  const { data, error } = await supabase
    .from('routines')
    .select('*')
    .eq('user_uuid', userUuid)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn('⚠️ Failed to fetch latest user routine:', error.message || error);
    return null;
  }

  return data;
}

function buildAllowedExercisesEditPrompt(userMessage, currentRoutine, allowedExercises, filters = {}, userBodyweightKg = null) {
  const exerciseList = allowedExercises
    .map((exercise) => {
      const secondary = exercise.secondaryMuscles?.length ? exercise.secondaryMuscles.join(', ') : 'None';
      return `- ID ${exercise.id}: ${exercise.name} | bodyPart: ${exercise.bodyPart || 'Unknown'} | equipment: ${exercise.equipment || 'None'} | target: ${exercise.target || 'None'} | secondaryMuscles: ${secondary} | difficulty: ${exercise.difficulty || 'Unknown'} | workoutType: ${exercise.workoutType || 'General'} | category: ${exercise.category || 'General'} | cardCategory: ${exercise.cardCategory || 'NORMAL'}`;
    })
    .join('\n');

  const currentRoutineList = Array.isArray(currentRoutine.exercises)
    ? currentRoutine.exercises
        .map((exercise) => {
          const exerciseId = exercise.exerciseId ?? exercise.id ?? 'unknown';
          const exerciseName = exercise.name || 'Unknown';
          const notes = Array.isArray(exercise.notes) ? exercise.notes.join(', ') : 'None';
          const sets = Array.isArray(exercise.sets)
            ? exercise.sets.map((set) => `${set.reps || '?'} reps @ ${set.kg || set.weight || '?'} kg`).join('; ')
            : 'None';
          const cardCategory = exercise.exercise_card_category || exercise.cardCategory || exercise.category || 'NORMAL';
          return `- ID ${exerciseId}: ${exerciseName} | sets: ${sets} | notes: ${notes} | category: ${cardCategory}`;
        })
        .join('\n')
    : 'No current routine exercises available.';

  const preferenceFragments = [];
  if (filters.muscleGroups?.length) preferenceFragments.push(`Muscle groups: ${filters.muscleGroups.join(', ')}`);
  if (filters.equipment?.length) preferenceFragments.push(`Equipment: ${filters.equipment.join(', ')}`);
  if (filters.difficulty?.length) preferenceFragments.push(`Difficulty: ${filters.difficulty.join(', ')}`);
  if (filters.workoutType?.length) preferenceFragments.push(`Workout type: ${filters.workoutType.join(', ')}`);

  const preferenceText = preferenceFragments.length
    ? `User preferences:\n${preferenceFragments.join('\n')}`
    : 'No explicit additional preferences were provided.';

  const bodyweightNote = userBodyweightKg
    ? `\nUser bodyweight: ${userBodyweightKg} kg. For bodyweight related exercises, return the actual stored load in kg: use the user's bodyweight for BW exercises, the total final load for BW_WEIGHTED exercises (bodyweight + added weight), and the actual reduced load for BW_ASSISTED exercises (bodyweight - assistance). Choose realistic weights based on the user's bodyweight.`
    : '';

  return `Based on this request: "${userMessage}"
${preferenceText}${bodyweightNote}

You are a professional fitness coach. The user already has a saved routine. Use the current routine below and make only the changes requested by the user. Preserve the existing structure, balance, and the exercises that are not explicitly replaced.
If the user specifically requests a named exercise, prefer that exercise from the allowed candidate list.
If the user's request changes the routine focus or asks for a new routine title, update the title accordingly. Keep the existing title only when no rename or focus change is requested.

Current saved routine:
${currentRoutine.title || 'Untitled Routine'}
${currentRoutineList}

Available exercise candidates:
${exerciseList}

Important:
- Keep the routine between 4 and 8 unique exercises.
- Do not invent, rename, substitute, or use any exercise that is not present in the candidate list.
- If the user asks to replace one exercise, select the best replacement from the candidate list and keep the rest of the routine unchanged unless balance requires a small adjustment.
- Keep the routine title the same unless the user explicitly asks to rename it.
- Return only valid JSON in this exact format:
{
  "title": "string",
  "exercises": [
    {
      "exercise_id": number,
      "notes": ["string"],
      "sets": [
        { "kg": number, "reps": number }
      ]
    }
  ]
}
- Do not select exercises with category BW_TIMED or TIMED because the app does not currently implement a timer.
- Prefer BW_ASSISTED for assisted calisthenics-style exercises when the user request mentions assistance.
- Choose realistic weights relative to the user's bodyweight and the exercise category.
- For BW_WEIGHTED exercises, the kg value must be the total final load after added weight.
- For BW_ASSISTED exercises, the kg value must be the actual assisted load after subtraction.
- For pure BW exercises, use the user's exact bodyweight as the load.
- Do not return unrealistic values such as 0 kg, 1000 kg, or negative loads.
- Only use the keys shown above.
- Use only exercise_id, notes, and sets for each exercise.
- Use only kg and reps for each set.
- For bodyweight, assisted, and weighted-bodyweight exercises, do NOT include BW, BW +, BW -, or any display-formatted weight text in the JSON.
- Do not include any other fields such as name, bodyPart, gifUrl, difficulty, rest_seconds, restSeconds, weight, or workout_type.
- Do not use exercise-level reps or set counts.
- Do not include markdown, comments, or extra text.
`;
}

async function editAndSaveRoutine(userMessage, userId, filters = {}, currentRoutine) {
  if (!currentRoutine || !currentRoutine.id) {
    throw new Error('Current routine is required to edit');
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY not configured in environment');
  }

  const candidateExercises = await fetchCandidateExercises(filters, userMessage);
  const allowedExerciseMap = new Map(candidateExercises.map((exercise) => [exercise.id, exercise]));

  if (Array.isArray(currentRoutine.exercises)) {
    for (const exercise of currentRoutine.exercises) {
      const exerciseId = Number(exercise.exerciseId ?? exercise.id ?? exercise.exercise_id);
      if (!Number.isInteger(exerciseId) || allowedExerciseMap.has(exerciseId)) {
        continue;
      }

      allowedExerciseMap.set(exerciseId, {
        id: exerciseId,
        name: exercise.name || 'Unknown',
        bodyPart: exercise.bodyPart || 'Unknown',
        target: exercise.target || '',
        equipment: exercise.equipment || '',
        difficulty: exercise.difficulty || '',
        workoutType: exercise.workoutType || exercise.type || '',
        category: exercise.category || '',
        cardCategory: exercise.exercise_card_category || exercise.cardCategory || exercise.card_category || 'NORMAL',
        secondaryMuscles: Array.isArray(exercise.secondaryMuscles) ? exercise.secondaryMuscles : [],
        gifUrl: exercise.gifUrl || '',
      });
    }
  }

  const allowedExercises = Array.from(allowedExerciseMap.values());
  const userBodyweightKg = await fetchLatestUserBodyweight(userId);
  const prompt = buildAllowedExercisesEditPrompt(userMessage, currentRoutine, allowedExercises, filters, userBodyweightKg);

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiApiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: prompt
        }]
      }],
      generationConfig: {
        maxOutputTokens: 1024,
        temperature: 0.7,
      }
    })
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Gemini API error: ${response.status} - ${JSON.stringify(errorData)}`);
  }

  const data = await response.json();
  let routineJson = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!routineJson) {
    throw new Error('Empty response from Gemini for routine edit');
  }

  let routineData;
  try {
    routineData = parseJsonResponseText(routineJson);
  } catch (parseError) {
    console.warn('⚠️ First routine edit parse failed, retrying once. Raw response:', routineJson, parseError.message);

    const retryResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `${prompt}\n\nThe previous response was invalid JSON. Reply again with only valid JSON in the same format, and do not include any extra text or markdown.`
          }]
        }],
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.0,
        }
      })
    });

    if (!retryResponse.ok) {
      const retryErrorData = await retryResponse.json();
      throw new Error(`Gemini retry error: ${retryResponse.status} - ${JSON.stringify(retryErrorData)}`);
    }

    const retryData = await retryResponse.json();
    const retryText = retryData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!retryText) {
      throw new Error('Empty retry response from Gemini for routine edit');
    }
    routineData = parseJsonResponseText(retryText);
  }

  const parsedRoutine = parseRoutineResponse(routineData, allowedExerciseMap);

  const routineExercises = parsedRoutine.exercises.map((exercise) => {
    const catalog = allowedExerciseMap.get(exercise.exerciseId);
    const exerciseCardCategory = catalog.exercise_card_category || catalog.cardCategory || catalog.card_category || 'NORMAL';

    const normalizedSets = Array.isArray(exercise.sets)
      ? exercise.sets.map((set) => ({
          kg: normalizeBwSetWeight(set, exerciseCardCategory, userBodyweightKg),
          reps: Math.max(0, Math.floor(parseNumberValue(set.reps ?? 0))),
        }))
      : [];

    return {
      id: catalog.id,
      name: catalog.name,
      notes: exercise.notes,
      sets: normalizedSets,
      bodyPart: catalog.bodyPart,
      secondaryMuscles: catalog.secondaryMuscles,
      gifUrl: catalog.gifUrl,
      exercise_card_category: exerciseCardCategory,
    };
  });

  const normalized = {
    title: parsedRoutine.title || currentRoutine.title || 'Updated Routine',
    exercises: routineExercises,
  };

  normalized.expected_time = calculateExpectedTime(normalized.exercises);
  normalized.difficulty = calculateDifficulty(normalized.exercises);

  console.log('✅ Routine edited:', normalized.title);
  return normalized;
}

function parseNumberValue(raw) {
  if (raw == null) return 0;
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw;
  const text = raw.toString().trim();
  if (!text) return 0;

  const sanitized = text
    .replace(/,/g, '')
    .replace(/bw|bodyweight|kg/gi, ' ');
  const match = sanitized.match(/[0-9]*\.?[0-9]+/);
  if (!match) return 0;
  const value = Number(match[0]);
  return Number.isNaN(value) ? 0 : value;
}

async function fetchLatestUserBodyweight(userUuid) {
  if (!userUuid) return null;

  const { data, error } = await supabase
    .from('measurements')
    .select('value')
    .eq('user_uuid', userUuid)
    .eq('name', 'weight')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.warn('⚠️ Failed to fetch user bodyweight measurement:', error.message || error);
    return null;
  }

  const row = Array.isArray(data) && data.length ? data[0] : null;
  const weightValue = row?.value;
  const parsedWeight = parseNumberValue(weightValue);
  return parsedWeight > 0 ? parsedWeight : null;
}

function normalizeBwSetWeight(set, exerciseCardCategory, userBodyweightKg) {
  const originalKg = parseNumberValue(set.kg ?? set.weight ?? 0);
  if (!userBodyweightKg || !Number.isFinite(userBodyweightKg) || userBodyweightKg <= 0) {
    return originalKg;
  }

  const normalizedCategory = (exerciseCardCategory || '').toString().toUpperCase();
  if (normalizedCategory === 'BW') {
    return userBodyweightKg;
  }

  if (normalizedCategory === 'BW_WEIGHTED') {
    if (originalKg > 0 && originalKg < userBodyweightKg * 0.6) {
      return userBodyweightKg + originalKg;
    }
    return originalKg;
  }

  if (normalizedCategory === 'BW_ASSISTED') {
    if (originalKg > 0 && originalKg < userBodyweightKg * 0.6) {
      return Math.max(userBodyweightKg - originalKg, 0);
    }
    if (originalKg > userBodyweightKg) {
      return userBodyweightKg;
    }
    return originalKg;
  }

  return originalKg;
}

function extractJsonString(text) {
  if (!text || typeof text !== 'string') return '';
  let trimmed = text.trim();

  if (trimmed.startsWith('```json')) {
    trimmed = trimmed.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
  } else if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```\n?/, '').replace(/\n?```$/, '').trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }

  return trimmed;
}

function parseJsonResponseText(rawText) {
  const jsonString = extractJsonString(rawText);
  if (!jsonString) {
    throw new Error(`Unable to extract JSON from response: ${rawText}`);
  }
  return JSON.parse(jsonString);
}

function parseRoutineResponse(routineData, allowedExerciseMap) {
  if (!routineData || typeof routineData !== 'object' || Array.isArray(routineData)) {
    throw new Error('Invalid routine payload from AI');
  }

  const allowedRoutineKeys = new Set(['title', 'routine_name', 'exercises']);
  const extraRoutineKeys = Object.keys(routineData).filter((key) => !allowedRoutineKeys.has(key));
  if (extraRoutineKeys.length) {
    throw new Error(`Routine response contains unexpected top-level fields: ${extraRoutineKeys.join(', ')}`);
  }

  const title = (routineData.title || routineData.routine_name || 'New Routine').toString();
  if (!Array.isArray(routineData.exercises)) {
    throw new Error('Routine response must include an exercises array');
  }

  const seenIds = new Set();
  const exercises = routineData.exercises.map((exercise, index) => {
    if (!exercise || typeof exercise !== 'object' || Array.isArray(exercise)) {
      throw new Error(`Exercise at index ${index} is invalid`);
    }

    const exerciseId = Number(
      exercise.exercise_id ?? exercise.exerciseId ?? exercise.id
    );
    if (!Number.isInteger(exerciseId)) {
      throw new Error(`Invalid exercise_id at index ${index}`);
    }

    if (!allowedExerciseMap.has(exerciseId)) {
      throw new Error(`Exercise ID ${exerciseId} is not allowed`);
    }

    if (seenIds.has(exerciseId)) {
      throw new Error(`Duplicate exercise_id ${exerciseId} is not allowed`);
    }
    seenIds.add(exerciseId);

    const allowedExerciseKeys = new Set(['exercise_id', 'exerciseId', 'id', 'notes', 'sets']);
    const unexpectedExerciseKeys = Object.keys(exercise).filter((key) => !allowedExerciseKeys.has(key));
    if (unexpectedExerciseKeys.length) {
      throw new Error(`Exercise ${exerciseId} contains unexpected fields: ${unexpectedExerciseKeys.join(', ')}`);
    }

    if (!Array.isArray(exercise.sets)) {
      throw new Error(`Exercise ${exerciseId} must include a sets array`);
    }

    const sets = exercise.sets.map((set, setIndex) => {
      if (!set || typeof set !== 'object' || Array.isArray(set)) {
        throw new Error(`Set at index ${setIndex} for exercise ${exerciseId} is invalid`);
      }

      const allowedSetKeys = new Set(['kg', 'weight', 'reps']);
      const unexpectedSetKeys = Object.keys(set).filter((key) => !allowedSetKeys.has(key));
      if (unexpectedSetKeys.length) {
        throw new Error(`Set ${setIndex} for exercise ${exerciseId} contains unexpected fields: ${unexpectedSetKeys.join(', ')}`);
      }

      const rawKg = set.kg ?? set.weight ?? 0;
      const kg = parseNumberValue(rawKg);
      const reps = Math.max(0, Math.floor(parseNumberValue(set.reps ?? 0)));

      return {
        kg,
        reps,
      };
    });

    if (sets.length === 0) {
      throw new Error(`Exercise ${exerciseId} must include at least one set`);
    }

    const notes = Array.isArray(exercise.notes)
      ? exercise.notes.map((note) => note?.toString() ?? '')
      : [];

    return {
      exerciseId,
      sets,
      notes,
    };
  });

  return {
    title,
    exercises,
  };
}

// Endpoint to send message
app.post('/send-message', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Missing or invalid authorization token'
      });
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(token);
    } catch (tokenError) {
      return res.status(401).json({
        success: false,
        error: 'Invalid Token',
        message: 'Failed to verify Firebase token: ' + tokenError.message
      });
    }

    const senderId = decoded.uid;
    const {
      conversationId,
      content,
      senderRole,
      muscleGroups,
      equipment,
      difficulty,
      workoutType,
    } = req.body;

    const filters = {
      muscleGroups: normalizeToArray(muscleGroups),
      equipment: normalizeToArray(equipment),
      difficulty: normalizeToArray(difficulty),
      workoutType: normalizeToArray(workoutType),
    };

    // Validate input
    if (!conversationId) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'conversationId is required'
      });
    }

    if (!content || typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'content is required and must be a non-empty string'
      });
    }

    console.log(`📨 Message from ${senderId} in conversation ${conversationId}`);

    // Fetch conversation
    const { data: convo, error: convoError } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', conversationId)
      .single();

    if (convoError || !convo) {
      console.error('❌ Conversation not found:', convoError || 'No data');
      return res.status(404).json({
        success: false,
        error: 'Conversation Not Found',
        message: `Conversation with ID ${conversationId} does not exist`
      });
    }

    // Determine sender role
    let role = senderRole; // Use provided role if given
    if (!role) {
      // Auto-detect based on user ID
      if (senderId === convo.user_id) role = 'user';
      else if (senderId === convo.coach_id) role = 'coach';
      else {
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'User is not part of this conversation'
        });
      }
    }

    // Validate role
    if (!['user', 'coach'].includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'senderRole must be either "user" or "coach"'
      });
    }

    // Insert user message into Supabase
    const { data: userMessage, error: insertError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: senderId,
        sender_role: role,
        content: content.trim(),
      })
      .select()
      .single();

    if (insertError) {
      console.error('❌ Failed to insert message:', insertError);
      return res.status(500).json({
        success: false,
        error: 'Database Error',
        message: 'Failed to save message to database: ' + insertError.message
      });
    }

    console.log('✅ User message sent successfully:', userMessage.id);

    // Check if this conversation is with the AI bot
    if (convo.coach_id === BOT_USER_ID) {
      console.log('🤖 Bot conversation detected, generating AI response...');
      
      try {
        // Generate AI response using Gemini (pass userId for routine saving)
        const botResponseData = await generateBotResponse(content, senderId, filters);
        
        let savedRoutine = null;
        let routineSaved = false;
        if (botResponseData.routine) {
          const routinePayload = {
            user_uuid: senderId,
            title: botResponseData.routine.title || botResponseData.routine.routine_name,
            exercises: botResponseData.routine.exercises,
            expected_time: botResponseData.routine.expected_time,
            difficulty: botResponseData.routine.difficulty,
          };

          const { data: routineData, error: routineError } = await supabase
            .from('routines')
            .insert(routinePayload)
            .select()
            .single();

          if (routineError) {
            console.error('⚠️ Failed to save routine:', routineError);
          } else {
            console.log('✅ Routine saved to Supabase');
            savedRoutine = routineData;
            routineSaved = true;
          }
        }
        
        // Insert bot response message into Supabase (use friendly message)
        let botMessageText = botResponseData.message;
        if (savedRoutine && savedRoutine.id) {
          botMessageText += `\n\n[ROUTINE_ID:${savedRoutine.id}]`;
        }

        const { data: botMessage, error: botInsertError } = await supabase
          .from('messages')
          .insert({
            conversation_id: conversationId,
            sender_id: BOT_USER_ID,
            sender_role: 'coach',
            content: botMessageText,
          })
          .select()
          .single();

        if (botInsertError) {
          console.error('❌ Failed to insert bot response:', botInsertError);
          // Still return success for user message, bot response just failed
          return res.status(201).json({
            success: true,
            message: 'Message sent successfully',
            data: userMessage,
            botResponseFailed: true
          });
        }

        console.log('✅ Bot response sent:', botMessage.id);
        
        return res.status(201).json({
          success: true,
          message: 'Message sent and AI response generated',
          data: userMessage,
          botResponse: botMessage,
          botRoutine: savedRoutine,
          routineSaved: routineSaved,
        });
      } catch (botError) {
        console.error('⚠️ Bot response generation failed:', botError);
        // Return success for user message, indicate bot failed
        return res.status(201).json({
          success: true,
          message: 'Message sent but AI response failed',
          data: userMessage,
          botError: botError.message
        });
      }
    } else {
      // Send notification to human recipient
      await sendNotificationToRecipient(convo, senderId, role, content);
      
      return res.status(201).json({
        success: true,
        message: 'Message sent successfully',
        data: userMessage
      });
    }

  } catch (error) {
    console.error('❌ Unexpected error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error.message || 'An unexpected error occurred'
    });
  }
});

async function classifyUserIntent(userMessage) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY not configured in environment');
  }

  const prompt = `Classify the user message into ONE of these intents:
- "WORKOUT_GENERATION"
- "ROUTINE_EDIT"
- "FITNESS_CHAT"

Also extract any explicit workout preferences found in the message. Return ONLY valid JSON in this exact shape:
{
  "intent": "WORKOUT_GENERATION" | "ROUTINE_EDIT" | "FITNESS_CHAT",
  "goal": "string",
  "muscleGroups": ["string"],
  "equipment": ["string"],
  "difficulty": "string",
  "duration": number,
  "modification": "string"
}

If a field cannot be determined, use an empty string, empty array, or 0.

User message:
"${userMessage}"
`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiApiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{
          text: 'You are an intent classifier for a fitness assistant. Return only valid JSON with no explanation or extra text.'
        }]
      },
      contents: [{
        parts: [{
          text: prompt
        }]
      }],
      generationConfig: {
        maxOutputTokens: 200,
        temperature: 0.0,
      }
    })
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Gemini intent classification error: ${response.status} - ${JSON.stringify(errorData)}`);
  }

  const data = await response.json();
  let intentJson = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!intentJson) {
    throw new Error('Empty intent classification response from Gemini');
  }

  if (intentJson.startsWith('```json')) {
    intentJson = intentJson.replace(/^```json\n?/, '').replace(/\n?```$/, '');
  } else if (intentJson.startsWith('```')) {
    intentJson = intentJson.replace(/^```\n?/, '').replace(/\n?```$/, '');
  }

  intentJson = intentJson.trim();
  const intentData = JSON.parse(intentJson);
  const intent = (intentData.intent || '').toString().trim().toUpperCase();
  if (!['WORKOUT_GENERATION', 'ROUTINE_EDIT', 'FITNESS_CHAT'].includes(intent)) {
    throw new Error(`Invalid intent returned from classifier: ${intent}`);
  }

  return {
    intent,
    goal: intentData.goal?.toString().trim() || '',
    muscleGroups: Array.isArray(intentData.muscleGroups) ? intentData.muscleGroups.map((item) => item?.toString().trim()).filter(Boolean) : [],
    equipment: Array.isArray(intentData.equipment) ? intentData.equipment.map((item) => item?.toString().trim()).filter(Boolean) : [],
    difficulty: intentData.difficulty?.toString().trim() || '',
    duration: Number.isFinite(Number(intentData.duration)) ? Number(intentData.duration) : 0,
  };
}

// Generate AI bot response using Groq
async function generateBotResponse(userMessage, userId, filters = {}) {
  try {
    const intentData = await classifyUserIntent(userMessage);
    console.log('🔎 Intent detection result:', intentData);

    if (intentData.intent === 'ROUTINE_EDIT') {
      console.log('✏️ Routine edit intent detected, updating saved routine...');

      const existingRoutine = await fetchLatestUserRoutine(userId);
      if (!existingRoutine) {
        throw new Error('No existing routine found to edit.');
      }

      const mergedFilters = {
        muscleGroups: [...new Set([...(filters.muscleGroups || []), ...intentData.muscleGroups])],
        equipment: [...new Set([...(filters.equipment || []), ...intentData.equipment])],
        difficulty: [...new Set([...(filters.difficulty || []), ...(intentData.difficulty ? [intentData.difficulty] : [])])],
        workoutType: [...new Set([...(filters.workoutType || []), ...(intentData.goal ? [intentData.goal] : [])])],
      };

      const enhancedFilters = normalizeWorkoutFilters({
        ...mergedFilters,
        goal: intentData.goal,
        userMessage,
      });

      const routine = await editAndSaveRoutine(userMessage, userId, enhancedFilters, existingRoutine);
      let savedRoutine = null;
      let routineSaved = false;

      const { data: updatedRoutine, error: routineError } = await supabase
        .from('routines')
        .update({
          title: routine.title,
          exercises: routine.exercises,
          expected_time: routine.expected_time,
          difficulty: routine.difficulty,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingRoutine.id)
        .select()
        .single();

      if (routineError) {
        console.error('⚠️ Failed to update edited routine:', routineError);
      } else {
        savedRoutine = updatedRoutine;
        routineSaved = true;
      }

      const routineTitle = routine.title || existingRoutine.title || 'Updated Routine';
      return {
        message: `I've updated your routine "${routineTitle}" according to your request. Tap the button below to view it.`,
        routine: routine,
        botRoutine: savedRoutine,
        routineSaved,
      };
    }

    if (intentData.intent === 'WORKOUT_GENERATION') {
      console.log('📋 Workout intent detected, generating routine...');

      const mergedFilters = {
        muscleGroups: [...new Set([...(filters.muscleGroups || []), ...intentData.muscleGroups])],
        equipment: [...new Set([...(filters.equipment || []), ...intentData.equipment])],
        difficulty: [...new Set([...(filters.difficulty || []), ...(intentData.difficulty ? [intentData.difficulty] : [])])],
        workoutType: [...new Set([...(filters.workoutType || []), ...(intentData.goal ? [intentData.goal] : [])])],
      };

      const enhancedFilters = normalizeWorkoutFilters({
        ...mergedFilters,
        goal: intentData.goal,
        userMessage,
      });

      const routine = await generateAndSaveRoutine(userMessage, userId, enhancedFilters);
      const routineTitle = routine.title || routine.routine_name || 'New Routine';
      return {
        message: `I've created a personalized workout routine called "${routineTitle}". Tap the button below to view it.`,
        routine: routine
      };
    }

    // Normal chat response
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY not configured in environment');
    }

    const systemPrompt = 'You are Motion Coach, a professional fitness coach AI assistant. Help users with fitness advice, motivation, and general questions. Keep responses concise and friendly (2-3 sentences max). Stay focused on fitness/health topics.';

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: systemPrompt
          }]
        },
        contents: [{
          parts: [{
            text: userMessage
          }]
        }],
        generationConfig: {
          maxOutputTokens: 256,
          temperature: 0.7,
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Gemini API error: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    const botMessage = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!botMessage) {
      throw new Error('Empty response from Gemini API');
    }

    console.log('✅ Bot response generated successfully with Gemini');
    return {
      message: botMessage,
      routine: null
    };

  } catch (error) {
    console.error('❌ Error generating bot response:', error);

    if (error?.message?.includes('No exercise candidates available for routine generation')) {
      return {
        message: 'I could not find enough exercises that match your request. Please try again with more detail or a different combination of muscle groups and equipment, like "dumbbells only workout for chest and biceps."',
        routine: null,
      };
    }

    if (error?.message?.includes('No existing routine found to edit')) {
      return {
        message: 'I could not find an existing routine to edit. Please create a routine first, then ask me to modify it.',
        routine: null,
      };
    }

    throw error;
  }
}

async function generateAndSaveRoutine(userMessage, userId, filters = {}) {
  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY not configured in environment');
    }

    const candidateExercises = await fetchCandidateExercises(filters, userMessage);
    if (!candidateExercises.length) {
      throw new Error('No exercise candidates available for routine generation');
    }

    const allowedExerciseMap = new Map(candidateExercises.map((exercise) => [exercise.id, exercise]));
    const userBodyweightKg = await fetchLatestUserBodyweight(userId);
    const prompt = buildAllowedExercisesPrompt(userMessage, candidateExercises, filters, userBodyweightKg);

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.7,
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Gemini API error: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    let routineJson = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!routineJson) {
      throw new Error('Empty response from Gemini for routine');
    }

    let routineData;
    try {
      routineData = parseJsonResponseText(routineJson);
    } catch (parseError) {
      console.warn('⚠️ First routine parse failed, retrying once. Raw response:', routineJson, parseError.message);

      const retryResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiApiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `${prompt}\n\nThe previous response was invalid JSON. Reply again with only valid JSON in the same format, and do not include any extra text or markdown.`
            }]
          }],
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.0,
          }
        })
      });

      if (!retryResponse.ok) {
        const retryErrorData = await retryResponse.json();
        throw new Error(`Gemini retry error: ${retryResponse.status} - ${JSON.stringify(retryErrorData)}`);
      }

      const retryData = await retryResponse.json();
      const retryText = retryData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!retryText) {
        throw new Error('Empty retry response from Gemini for routine');
      }
      routineData = parseJsonResponseText(retryText);
    }

    const parsedRoutine = parseRoutineResponse(routineData, allowedExerciseMap);

    const routineExercises = parsedRoutine.exercises.map((exercise) => {
      const catalog = allowedExerciseMap.get(exercise.exerciseId);
      const exerciseCardCategory = catalog.exercise_card_category || catalog.cardCategory || catalog.card_category || 'NORMAL';

      const normalizedSets = Array.isArray(exercise.sets)
        ? exercise.sets.map((set) => ({
            kg: normalizeBwSetWeight(set, exerciseCardCategory, userBodyweightKg),
            reps: Math.max(0, Math.floor(parseNumberValue(set.reps ?? 0))),
          }))
        : [];

      return {
        id: catalog.id,
        name: catalog.name,
        notes: exercise.notes,
        sets: normalizedSets,
        bodyPart: catalog.bodyPart,
        secondaryMuscles: catalog.secondaryMuscles,
        gifUrl: catalog.gifUrl,
        exercise_card_category: exerciseCardCategory,
      };
    });

    const normalized = {
      title: parsedRoutine.title,
      exercises: routineExercises,
    };

    normalized.expected_time = calculateExpectedTime(normalized.exercises);
    normalized.difficulty = calculateDifficulty(normalized.exercises);

    console.log('✅ Routine generated:', normalized.title);
    return normalized;

  } catch (error) {
    console.error('❌ Error generating routine:', error);
    throw error;
  }
}

// Send notification to recipient

async function sendNotificationToRecipient(conversation, senderId, senderRole, messageContent) {
  try {
    // Determine recipient
    const recipientId = senderRole === 'user' ? conversation.coach_id : conversation.user_id;
    
    // Get sender's name from Firebase
    const senderRecord = await admin.auth().getUser(senderId);
    const senderEmail = senderRecord.email || 'Unknown';
    const senderName = senderRecord.displayName || senderEmail.split('@')[0];

    // Get recipient's custom claims (FCM topics they're subscribed to)
    const recipientRecord = await admin.auth().getUser(recipientId);
    const recipientEmail = recipientRecord.email || 'Unknown';

    console.log(`📱 Sending notification to ${recipientEmail} from ${senderName}`);

    // Send multicast notification using topic
    const recipientTopic = `user_${recipientId}`;
    
    const message = {
      notification: {
        title: senderName,
        body: messageContent.substring(0, 100),
      },
      data: {
        conversation_id: conversation.id,
        sender_id: senderId,
        sender_role: senderRole,
      },
      topic: recipientTopic,
    };

    const response = await admin.messaging().send(message);
    console.log('✅ Notification sent:', response);

  } catch (error) {
    console.error('⚠️ Warning: Failed to send notification:', error.message);
    // Don't fail the message send if notification fails
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test endpoint: Create a test conversation
// Usage: POST /create-test-conversation
// Body: { userId: 'firebase-uid-1', coachId: 'firebase-uid-2' }
app.post('/create-test-conversation', async (req, res) => {
  try {
    const { userId, coachId } = req.body;

    if (!userId || !coachId) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'userId and coachId are required'
      });
    }

    // Create conversation with auto-generated UUID
    const { data: conversation, error } = await supabase
      .from('conversations')
      .insert({
        user_id: userId,
        coach_id: coachId,
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Failed to create conversation:', error);
      return res.status(500).json({
        success: false,
        error: 'Database Error',
        message: 'Failed to create conversation: ' + error.message
      });
    }

    console.log('✅ Test conversation created:', conversation.id);
    return res.status(201).json({
      success: true,
      message: 'Test conversation created',
      data: {
        conversationId: conversation.id,
        userId: conversation.user_id,
        coachId: conversation.coach_id,
        createdAt: conversation.created_at
      }
    });

  } catch (error) {
    console.error('❌ Unexpected error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error.message || 'An unexpected error occurred'
    });
  }
});

// Get or create AI bot conversation for the current user
// Usage: POST /get-bot-conversation
// No body required, uses Firebase token
app.post('/get-bot-conversation', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Missing or invalid authorization token'
      });
    }

    console.log('🤖 [GET_BOT_CONVERSATION] Starting...');

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(token);
      console.log('✅ [GET_BOT_CONVERSATION] Firebase verified for user:', decoded.uid);
    } catch (tokenError) {
      console.error('❌ [GET_BOT_CONVERSATION] Firebase verification failed:', tokenError.message);
      return res.status(401).json({
        success: false,
        error: 'Invalid Token',
        message: 'Failed to verify Firebase token: ' + tokenError.message
      });
    }

    const userId = decoded.uid;

    // Check if bot conversation already exists (with timeout)
    console.log('🔍 [GET_BOT_CONVERSATION] Checking for existing conversation...');
    
    let existingConvo = null;
    try {
      const result = await Promise.race([
        supabase
          .from('conversations')
          .select('*')
          .eq('user_id', userId)
          .eq('coach_id', BOT_USER_ID)
          .maybeSingle(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Supabase query timeout')), 5000)
        )
      ]);

      if (result && typeof result === 'object' && 'data' in result) {
        existingConvo = result.data;
      } else {
        console.warn('⚠️ [GET_BOT_CONVERSATION] Unexpected query result, will create new:', result);
      }
    } catch (queryError) {
      console.warn('⚠️ [GET_BOT_CONVERSATION] Query timeout or failure, will create new:', queryError.message);
      existingConvo = null;
    }

    if (existingConvo) {
      const elapsed = Date.now() - startTime;
      console.log(`✅ [GET_BOT_CONVERSATION] Existing bot conversation found: ${existingConvo.id} (${elapsed}ms)`);
      return res.status(200).json({
        success: true,
        message: 'Bot conversation retrieved',
        data: {
          conversationId: existingConvo.id,
          userId: existingConvo.user_id,
          coachId: existingConvo.coach_id,
          createdAt: existingConvo.created_at
        }
      });
    }

    // Create new bot conversation
    console.log('➕ [GET_BOT_CONVERSATION] Creating new bot conversation...');
    
    let newConvo = null;
    try {
      const result = await Promise.race([
        supabase
          .from('conversations')
          .insert({
            user_id: userId,
            coach_id: BOT_USER_ID,
          })
          .select()
          .single(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Supabase insert timeout')), 5000)
        )
      ]);

      if (result && typeof result === 'object' && 'data' in result) {
        newConvo = result.data;
      } else {
        throw new Error(`Unexpected insert result: ${JSON.stringify(result)}`);
      }
    } catch (insertError) {
      console.error('❌ [GET_BOT_CONVERSATION] Failed to create bot conversation:', insertError.message);
      return res.status(500).json({
        success: false,
        error: 'Database Error',
        message: 'Failed to create bot conversation: ' + insertError.message
      });
    }

    const elapsed = Date.now() - startTime;
    console.log(`✅ [GET_BOT_CONVERSATION] Bot conversation created: ${newConvo.id} (${elapsed}ms)`);
    
    return res.status(201).json({
      success: true,
      message: 'Bot conversation created',
      data: {
        conversationId: newConvo.id,
        userId: newConvo.user_id,
        coachId: newConvo.coach_id,
        createdAt: newConvo.created_at
      }
    });

  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`❌ [GET_BOT_CONVERSATION] Unexpected error after ${elapsed}ms:`, error);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error.message || 'An unexpected error occurred'
    });
  }
});


// Test endpoint: List all conversations
// Usage: GET /list-conversations
app.get('/list-conversations', async (req, res) => {
  try {
    const { data: conversations, error } = await supabase
      .from('conversations')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({
        success: false,
        error: 'Database Error',
        message: 'Failed to list conversations: ' + error.message
      });
    }

    return res.status(200).json({
      success: true,
      count: conversations?.length || 0,
      data: conversations || []
    });

  } catch (error) {
    console.error('❌ Unexpected error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error.message || 'An unexpected error occurred'
    });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
