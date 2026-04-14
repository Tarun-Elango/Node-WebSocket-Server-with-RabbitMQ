const WebSocket = require('ws');
const { URL } = require('url');

/**
 * server keeps a map of topics to subscribers
 * on client, each client maintains a set of subscribed topics
 */

const PORT = 8080;
const DEFAULT_TOPIC = 'lobby';
const wss = new WebSocket.Server({ port: PORT });
const topicSubscribers = new Map();

console.log(`WebSocket server is running on ws://localhost:${PORT}`);

function normalizeTopic(topic) {
  return typeof topic === 'string' ? topic.trim() : '';
}

function sendSystemMessage(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(`System: ${message}`);
  }
}

function subscribeClient(ws, topic) {
  const normalizedTopic = normalizeTopic(topic);

  if (!normalizedTopic) {
    sendSystemMessage(ws, 'Topic name is required.');
    return false;
  }

  if (!topicSubscribers.has(normalizedTopic)) {
    topicSubscribers.set(normalizedTopic, new Set());
  }

  if (ws.subscriptions.has(normalizedTopic)) {
    sendSystemMessage(ws, `Already subscribed to "${normalizedTopic}".`);
    return false;
  }

  topicSubscribers.get(normalizedTopic).add(ws);
  ws.subscriptions.add(normalizedTopic);
  sendSystemMessage(ws, `Subscribed to "${normalizedTopic}".`);
  return true;
}

function unsubscribeClient(ws, topic) {
  const normalizedTopic = normalizeTopic(topic);

  if (!normalizedTopic) {
    sendSystemMessage(ws, 'Topic name is required.');
    return false;
  }

  if (!ws.subscriptions.has(normalizedTopic)) {
    sendSystemMessage(ws, `Not subscribed to "${normalizedTopic}".`);
    return false;
  }

  ws.subscriptions.delete(normalizedTopic);

  const subscribers = topicSubscribers.get(normalizedTopic);
  if (subscribers) {
    subscribers.delete(ws);

    if (subscribers.size === 0) {
      topicSubscribers.delete(normalizedTopic);
    }
  }

  sendSystemMessage(ws, `Unsubscribed from "${normalizedTopic}".`);
  return true;
}

function publishToTopic(ws, topic, message) {
  const normalizedTopic = normalizeTopic(topic);
  const text = typeof message === 'string' ? message.trim() : '';

  if (!normalizedTopic) {
    sendSystemMessage(ws, 'A topic is required to publish a message.');
    return;
  }

  if (!text) {
    sendSystemMessage(ws, 'Message text cannot be empty.');
    return;
  }

  if (!ws.subscriptions.has(normalizedTopic)) {
    sendSystemMessage(ws, `Subscribe to "${normalizedTopic}" before publishing to it.`);
    return;
  }

  const formattedMessage = `[${normalizedTopic}] ${ws.userName}: ${text}`;
  console.log(`Received: ${formattedMessage}`);

  const subscribers = topicSubscribers.get(normalizedTopic);// Get subscribers for the topic
  if (!subscribers) {
    sendSystemMessage(ws, `No subscribers found for "${normalizedTopic}".`);
    return;
  }

  // for each subscriber from the map, send the message if the connection is open
  subscribers.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(formattedMessage);
    }
  });
}

function removeClientFromAllTopics(ws) {
  ws.subscriptions.forEach((topic) => {
    const subscribers = topicSubscribers.get(topic);

    if (!subscribers) {
      return;
    }

    subscribers.delete(ws);

    if (subscribers.size === 0) {
      topicSubscribers.delete(topic);
    }
  });

  ws.subscriptions.clear();
}

function handleClientMessage(ws, rawMessage) {
  const text = rawMessage.toString().trim();

  if (!text) {
    return;
  }

  let payload;

  try {
    payload = JSON.parse(text);
  } catch (error) {
    publishToTopic(ws, DEFAULT_TOPIC, text);
    return;
  }

  if (!payload || typeof payload !== 'object') {
    sendSystemMessage(ws, 'Unsupported message format.');
    return;
  }

  // parse action from payload and normalize it
  const action = typeof payload.action === 'string' ? payload.action.trim().toLowerCase() : '';

  if (action === 'subscribe') {
    // subscribe client to the specified topic
    subscribeClient(ws, payload.topic);
    return;
  }

  if (action === 'unsubscribe') {
    // unsubscribe client from the specified topic
    unsubscribeClient(ws, payload.topic);
    return;
  }

  if (action === 'publish') {
    // publish message to the specified topic
    publishToTopic(ws, payload.topic, payload.message);
    return;
  }

  if (action === 'list') {
    const subscriptions = Array.from(ws.subscriptions).sort();
    sendSystemMessage(
      ws,
      subscriptions.length > 0
        ? `Current subscriptions: ${subscriptions.join(', ')}`
        : 'No active subscriptions.'
    );
    return;
  }

  sendSystemMessage(ws, 'Supported actions are subscribe, unsubscribe, publish, and list.');
}

// Handle new client connections
wss.on('connection', (ws, request) => {
  const requestUrl = new URL(request.url, `ws://localhost:${PORT}`);
  ws.userName = requestUrl.searchParams.get('name') || 'Anonymous';
  ws.subscriptions = new Set();

  console.log(`Client connected: ${ws.userName}`);

  // Send welcome message
  ws.send(`Welcome, ${ws.userName}!`);
  subscribeClient(ws, DEFAULT_TOPIC);
  sendSystemMessage(ws, 'Send JSON messages to subscribe, unsubscribe, publish, or list subscriptions.');

  // Handle incoming messages
  ws.on('message', (message) => {
    handleClientMessage(ws, message);
  });

  // Handle client disconnect
  ws.on('close', () => {
    removeClientFromAllTopics(ws);
    console.log(`Client disconnected: ${ws.userName}`);
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error(`WebSocket error: ${error.message}`);
  });
});

// Handle server errors
wss.on('error', (error) => {
  console.error(`Server error: ${error.message}`);
});


