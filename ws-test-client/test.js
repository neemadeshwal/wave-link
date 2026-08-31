const { io } = require('socket.io-client');

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkNDZiYzUzNi1iYTRhLTQ5MjQtYjdhMC04N2EzZGFmZmM4MmYiLCJlbWFpbCI6Im5lZW1hQGdtYWlsLmNvbSIsImlhdCI6MTc4ODIwNTUzNSwiZXhwIjoxNzg4MjA2NDM1fQ.5oJod2gsgwwZgjhu9c5cwYvdvrDJObgWl0J7iX_YN8Q';
const CONVERSATION_ID = '3f817c3b-aac8-40ef-b37d-0d9fda74cd81';

const socket = io('http://localhost:3000/chat', {
  auth: {
    token: TOKEN,
  },
});

socket.on('connect', () => {
  console.log('✅ Connected:', socket.id);

  // Now emit conversation:join WITH an acknowledgment callback
  socket.emit('conversation:join', { conversationId: CONVERSATION_ID }, (response) => {
    console.log('📩 Server responded:', response);
  });
});

socket.on('connect_error', (err) => {
  console.log('❌ Connection error:', err.message);
});

socket.on('disconnect', () => {
  console.log('🔌 Disconnected');
});