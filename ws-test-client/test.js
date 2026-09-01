const { io } = require('socket.io-client');

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkNDZiYzUzNi1iYTRhLTQ5MjQtYjdhMC04N2EzZGFmZmM4MmYiLCJlbWFpbCI6Im5lZW1hQGdtYWlsLmNvbSIsImlhdCI6MTc4ODI5NDQ0MiwiZXhwIjoxNzg4Mjk1MzQyfQ.L4jfgfdQRt935WXGS4B25P2hCmBpOIetVcU-NxZ9q18';
const CONVERSATION_ID = '3f817c3b-aac8-40ef-b37d-0d9fda74cd91';
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

// Only send message after successful joining 

 socket.emit('message:send',{
  conversationId:CONVERSATION_ID,
  content:"Hello from the test client",
  type:'TEXT'
 },
 (sendResponse)=>{
   console.log('📩 Send response:', sendResponse);
 }
)

socket.on('message:new',(message)=>{
   console.log('🔔 Received broadcast message:new:', message);
})
socket.on('connect_error', (err) => {
  console.log('❌ Connection error:', err.message);
});

socket.on('disconnect', () => {
  console.log('🔌 Disconnected');
});