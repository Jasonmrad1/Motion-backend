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
    const { conversationId, content, senderRole } = req.body;

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
        const botResponseData = await generateBotResponse(content, senderId);
        
        // If routine was generated, save it to Supabase
        if (botResponseData.routine) {
          const { error: routineError } = await supabase
            .from('routines')
            .insert({
              user_uuid: senderId,
              title: botResponseData.routine.title || botResponseData.routine.routine_name,
              exercises: botResponseData.routine.exercises,
            });

          if (routineError) {
            console.error('⚠️ Failed to save routine:', routineError);
          } else {
            console.log('✅ Routine saved to Supabase');
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
          botResponse: botMessage
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
async function generateBotResponse(userMessage, userId) {
  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY not configured in environment');
    }

    // Check if user is asking for a routine/workout generation
    const routineKeywords = ['routine', 'workout', 'program', 'generate', 'create', 'plan', 'design', 'build'];
    const isRoutineRequest = routineKeywords.some(keyword => userMessage.toLowerCase().includes(keyword));

    if (isRoutineRequest) {
      // Generate routine and save to Supabase
      console.log('📋 Routine request detected, generating routine...');
      const routine = await generateAndSaveRoutine(userMessage, userId);
      const routineTitle = routine.title || routine.routine_name || 'new routine';
      return {
        message: `I've created a personalized workout routine called "${routineTitle}". Check your Routines section to view and track it. 💪`,
        routine: routine
      };
    } else {
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
    }

  } catch (error) {
    console.error('❌ Error generating bot response:', error);
    throw error;
  }
}

async function generateAndSaveRoutine(userMessage, userId) {
  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    
    const routinePrompt = `Based on this request: "${userMessage}"
    
Generate a JSON fitness routine with this exact structure:
{
  "title": "string (e.g., 'Beginner Full Body')",
  "exercises": [
    {
      "name": "string",
      "sets": number,
      "reps": number,
      "rest_seconds": number
    }
  ]
}

Return ONLY valid JSON, no extra text.`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: routinePrompt
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

    // Strip markdown code blocks if present (Gemini sometimes wraps in ```json ... ```)
    if (routineJson.startsWith('```json')) {
      routineJson = routineJson.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    } else if (routineJson.startsWith('```')) {
      routineJson = routineJson.replace(/^```\n?/, '').replace(/\n?```$/, '');
    }

    routineJson = routineJson.trim();

    // Parse the JSON response
    const routineData = JSON.parse(routineJson);

    console.log('✅ Routine generated:', routineData.title || routineData.routine_name);
    
    return {
      ...routineData,
      title: routineData.title || routineData.routine_name,
    };

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

app.post('/generate-routine', async (req, res) => {
  try {
    const { userId, goal, level, equipment, bodyParts } = req.body;

    if (!userId || !goal || !level) {
      return res.status(400).json({
        success: false,
        message: "userId, goal, and level are required"
      });
    }

    // 1. Fetch exercises from Supabase
    const { data: exercises, error: exError } = await supabase
      .from("exercises")
      .select("id,name,bodyPart,equipment,target")
      .in("bodyPart", bodyParts || ["chest","legs","back"])
      .in("equipment", equipment || ["bodyweight","dumbbell"])
      .limit(50);

    if (exError || !exercises?.length) {
      return res.status(404).json({
        success: false,
        message: "No exercises found"
      });
    }

    // 2. Format exercise list for AI
    const exerciseList = exercises.map(e => `ID ${e.id}: ${e.name} (${e.equipment}, ${e.bodyPart})`).join("\n");

    // 3. Prompt for Groq
    const prompt = `
You are a professional fitness coach.
Generate a workout routine for a user with these details:
Goal: ${goal}
Level: ${level}

Use ONLY the exercises below.
Return ONLY valid JSON in this format:
{
  "routine_name": string,
  "exercises": [
    {"id": number, "sets": number, "reps": number, "rest": number}
  ]
}

Exercises list:
${exerciseList}
`;

    // 4. Call Groq API
    const response = await fetch("https://api.groq.com/v1/generate", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "groq-llm-mini",
        prompt: prompt,
        max_tokens: 500
      })
    });

    const data = await response.json();
    const routineJson = data.output_text; // adjust depending on Groq API response

    return res.status(200).json({
      success: true,
      data: JSON.parse(routineJson)
    });

  } catch (err) {
    console.error("❌ Routine generation error:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
