const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
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

    // Insert message into Supabase
    const { data: message, error: insertError } = await supabase
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

    console.log('✅ Message sent successfully:', message.id);
    
    // Send notification to recipient
    await sendNotificationToRecipient(convo, senderId, role, content);
    
    return res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      data: message
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
