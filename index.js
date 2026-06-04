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
const DEFAULT_ALLOWED_EXERCISE_LIMIT = 30;

function normalizeToArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => item?.toString().trim()).filter(Boolean);
  return value.toString().split(',').map((item) => item.trim()).filter(Boolean);
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

async function fetchAllowedExercises(filters = {}) {
  const { muscleGroups = [], equipment = [], difficulty = [], workoutType = [] } = filters;
  const { data: exercises, error } = await supabase
    .from('exercises')
    .select('*')
    .limit(DEFAULT_ALLOWED_EXERCISE_LIMIT * 2);

  if (error) {
    throw new Error(`Failed to load allowed exercises: ${error.message || error}`);
  }

  if (!Array.isArray(exercises) || exercises.length === 0) {
    return [];
  }

  return exercises
    .map((exercise) => ({
      id: Number(exercise.id),
      name: (exercise.name || exercise.exercise || '').toString().trim(),
      bodyPart: exercise.bodyPart || exercise.body_part || exercise.target || 'General',
      target: exercise.target || '',
      equipment: exercise.equipment || '',
      difficulty: exercise.difficulty || '',
      workoutType: exercise.workout_type || exercise.workoutType || exercise.type || '',
      secondaryMuscles: Array.isArray(exercise.secondaryMuscles)
        ? exercise.secondaryMuscles.map((m) => String(m))
        : exercise.secondaryMuscles != null
        ? [String(exercise.secondaryMuscles)]
        : [],
      gifUrl: exercise.gifUrl || '',
      exercise_card_category: exercise.exercise_card_category || exercise.exerciseCardCategory || 'NORMAL',
    }))
    .filter((exercise) => exercise.id && exercise.name)
    .filter((exercise) => {
      if (muscleGroups.length) {
        const muscleMatch = [exercise.bodyPart, exercise.target]
          .filter(Boolean)
          .some((field) => matchesFilterValue(field, muscleGroups));
        const secondaryMatch = exercise.secondaryMuscles.some((muscle) => matchesFilterValue(muscle, muscleGroups));
        if (!muscleMatch && !secondaryMatch) return false;
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
      return true;
    })
    .slice(0, DEFAULT_ALLOWED_EXERCISE_LIMIT);
}

function buildAllowedExercisesPrompt(userMessage, allowedExercises, filters = {}) {
  const exerciseList = allowedExercises
    .map((exercise) => `- ID ${exercise.id}: ${exercise.name}`)
    .join('\n');

  const preferenceFragments = [];
  if (filters.muscleGroups?.length) preferenceFragments.push(`Muscle groups: ${filters.muscleGroups.join(', ')}`);
  if (filters.equipment?.length) preferenceFragments.push(`Equipment: ${filters.equipment.join(', ')}`);
  if (filters.difficulty?.length) preferenceFragments.push(`Difficulty: ${filters.difficulty.join(', ')}`);
  if (filters.workoutType?.length) preferenceFragments.push(`Workout type: ${filters.workoutType.join(', ')}`);

  const preferenceText = preferenceFragments.length
    ? `User preferences:\n${preferenceFragments.join('\n')}`
    : 'No explicit additional preferences were provided.';

  return `Based on this request: "${userMessage}"
${preferenceText}

Generate a workout routine using ONLY the allowed exercises below.
Do not invent, rename, or substitute any exercise.

Fill in this exact JSON structure and return only valid JSON:
{
  "title": "string",
  "exercises": [
    {
      "exercise_id": number,
      "notes": ["string"],
      "sets": [
        { "kg": number, "reps": number, "rest": number }
      ]
    }
  ]
}

Allowed exercises:
${exerciseList}

Important:
- Only use the keys shown above.
- Use only exercise_id, notes, and sets for each exercise.
- Use only kg, reps, and rest for each set.
- Do not include any other fields such as name, bodyPart, gifUrl, difficulty, rest_seconds, restSeconds, weight, or workout_type.
- Do not use exercise-level reps or set counts.
- Use 4-8 unique exercises.
- Do not include markdown, comments, or extra text.
`;
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

      const allowedSetKeys = new Set(['kg', 'reps', 'rest']);
      const unexpectedSetKeys = Object.keys(set).filter((key) => !allowedSetKeys.has(key));
      if (unexpectedSetKeys.length) {
        throw new Error(`Set ${setIndex} for exercise ${exerciseId} contains unexpected fields: ${unexpectedSetKeys.join(', ')}`);
      }

      return {
        kg: Number(set.kg ?? 0) || 0,
        reps: Number(set.reps ?? 0) || 0,
        rest: Number(set.rest ?? 0) || 0,
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
        const { data: botMessage, error: botInsertError } = await supabase
          .from('messages')
          .insert({
            conversation_id: conversationId,
            sender_id: BOT_USER_ID,
            sender_role: 'coach',
            content: botResponseData.message,
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

// Generate AI bot response using Groq
async function generateBotResponse(userMessage, userId, filters = {}) {
  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY not configured in environment');
    }

    // Check if user is asking for a routine/workout generation
    const routineKeywords = ['routine', 'workout', 'program', 'generate', 'create', 'plan', 'design', 'build'];
    const isRoutineRequest = routineKeywords.some(keyword => userMessage.toLowerCase().includes(keyword));

    if (isRoutineRequest) {
      console.log('📋 Routine request detected, generating routine...');
      const routine = await generateAndSaveRoutine(userMessage, userId, filters);
      const routineTitle = routine.title || routine.routine_name || 'New Routine';
      return {
        message: `I've created a personalized workout routine called "${routineTitle}". Check your Routines section to view and track it. 💪`,
        routine: routine
      };
    }

    // Normal chat response
    const systemPrompt = 'You are Motion Coach, a professional fitness coach AI assistant. Help users with fitness advice, motivation, and general questions. Keep responses concise and friendly (2-3 sentences max). Stay focused on fitness/health topics.';

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiApiKey}`, {
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
    throw error;
  }
}

async function generateAndSaveRoutine(userMessage, userId, filters = {}) {
  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY not configured in environment');
    }

    const allowedExercises = await fetchAllowedExercises(filters);
    if (!allowedExercises.length) {
      throw new Error('No allowed exercises available for the requested preferences');
    }

    const allowedExerciseMap = new Map(allowedExercises.map((exercise) => [exercise.id, exercise]));
    const prompt = buildAllowedExercisesPrompt(userMessage, allowedExercises, filters);

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiApiKey}`, {
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

    if (routineJson.startsWith('```json')) {
      routineJson = routineJson.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    } else if (routineJson.startsWith('```')) {
      routineJson = routineJson.replace(/^```\n?/, '').replace(/\n?```$/, '');
    }

    routineJson = routineJson.trim();
    const routineData = JSON.parse(routineJson);
    const parsedRoutine = parseRoutineResponse(routineData, allowedExerciseMap);

    const routineExercises = parsedRoutine.exercises.map((exercise) => {
      const catalog = allowedExerciseMap.get(exercise.exerciseId);
      return {
        id: catalog.id,
        name: catalog.name,
        notes: exercise.notes,
        sets: exercise.sets,
        bodyPart: catalog.bodyPart,
        secondaryMuscles: catalog.secondaryMuscles,
        gifUrl: catalog.gifUrl,
        exercise_card_category: catalog.exercise_card_category,
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
    
    let existingConvo;
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
      existingConvo = result.data; // Extract data from Supabase response
    } catch (queryError) {
      console.warn('⚠️ [GET_BOT_CONVERSATION] Query timeout, will create new:', queryError.message);
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
    
    let newConvo;
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
      newConvo = result.data; // Extract data from Supabase response
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
