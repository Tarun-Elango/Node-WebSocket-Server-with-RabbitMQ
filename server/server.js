const amqp = require('amqplib');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const { URL } = require('url');

/**
 * server keeps a map of topics to subscribers
 * on client, each client maintains a set of subscribed topics
 */

const PORT = Number(process.env.PORT) || 8080;
const DEFAULT_TOPIC = process.env.DEFAULT_TOPIC || 'lobby';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';
const RABBITMQ_EXCHANGE = process.env.RABBITMQ_EXCHANGE || 'ws.topics';
const NODE_ID = process.env.NODE_ID || randomUUID();
const topicSubscribers = new Map();
const rabbitBoundTopics = new Set();

let rabbitConnection;
let rabbitPublisherChannel;
let rabbitSubscriberChannel;
let rabbitQueueName;
let wss;
let isShuttingDown = false;

function normalizeTopic(topic) {
  return typeof topic === 'string' ? topic.trim() : '';
}

function serializeBrokerMessage(topic, formattedMessage, userName) {
  return JSON.stringify({
    nodeId: NODE_ID,
    topic,
    formattedMessage,
    userName,
    publishedAt: new Date().toISOString(),
  });
}

function sendSystemMessage(ws, message) {
  // for all open connections, send the message as a system message
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(`System: ${message}`);
  }
}

function fanOutToLocalSubscribers(topic, formattedMessage) {
  const subscribers = topicSubscribers.get(topic);

  if (!subscribers || subscribers.size === 0) {
    return;
  }

  subscribers.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(formattedMessage);
    }
  });
}

async function bindTopicToNodeQueue(topic) {
  if (rabbitBoundTopics.has(topic)) {
    return;
  }

  // bind the topic to this node's RabbitMQ queue
  await rabbitSubscriberChannel.bindQueue(rabbitQueueName, RABBITMQ_EXCHANGE, topic);
  rabbitBoundTopics.add(topic);
}

async function unbindTopicFromNodeQueue(topic) {
  if (!rabbitBoundTopics.has(topic)) {
    return;
  }

  await rabbitSubscriberChannel.unbindQueue(rabbitQueueName, RABBITMQ_EXCHANGE, topic);
  rabbitBoundTopics.delete(topic);
}

function removeLocalSubscription(ws, topic) {
  ws.subscriptions.delete(topic);

  const subscribers = topicSubscribers.get(topic);
  if (!subscribers) {
    return false;
  }

  subscribers.delete(ws);

  if (subscribers.size === 0) {
    topicSubscribers.delete(topic);
    return true;
  }

  return false;
}

async function initializeRabbitMq() {
  rabbitConnection = await amqp.connect(RABBITMQ_URL);
  rabbitPublisherChannel = await rabbitConnection.createConfirmChannel();
  rabbitSubscriberChannel = await rabbitConnection.createChannel();

  rabbitConnection.on('error', (error) => {
    console.error(`RabbitMQ connection error: ${error.message}`);
  });

  rabbitConnection.on('close', () => {
    if (isShuttingDown) {
      return;
    }

    console.error('RabbitMQ connection closed. Exiting so the process manager can restart this node.');
    process.exit(1);
  });

  await rabbitPublisherChannel.assertExchange(RABBITMQ_EXCHANGE, 'topic', { durable: false });
  await rabbitSubscriberChannel.assertExchange(RABBITMQ_EXCHANGE, 'topic', { durable: false });

  const { queue } = await rabbitSubscriberChannel.assertQueue('', {
    autoDelete: true,
    durable: false,
    exclusive: true,
  });

  rabbitQueueName = queue;


  // this will receive messages published by this node as well as messages from other nodes for topics this node is subscribed to
  await rabbitSubscriberChannel.consume(rabbitQueueName, (message) => {
    if (!message) {
      return;
    }

    try {
      const payload = JSON.parse(message.content.toString());
      const topic = normalizeTopic(message.fields.routingKey || payload.topic);

      if (!topic || typeof payload.formattedMessage !== 'string') {
        return;
      }

      fanOutToLocalSubscribers(topic, payload.formattedMessage);
    } catch (error) {
      console.error(`Failed to process RabbitMQ message: ${error.message}`);
    } finally {
      rabbitSubscriberChannel.ack(message);
    }
  });

  console.log(`RabbitMQ connected at ${RABBITMQ_URL}; node id ${NODE_ID}`);
}

async function subscribeClient(ws, topic) {
  const normalizedTopic = normalizeTopic(topic);

  if (!normalizedTopic) {
    sendSystemMessage(ws, 'Topic name is required.');
    return false;
  }

  if (!topicSubscribers.has(normalizedTopic)) {
    topicSubscribers.set(normalizedTopic, new Set());
  }

  // if client is already subscribed to this topic, no need to bind again or add duplicate subscription
  if (ws.subscriptions.has(normalizedTopic)) {
    sendSystemMessage(ws, `Already subscribed to "${normalizedTopic}".`);
    return false;
  }

  // get existing subscribers for this topic (if any) and add this client to the set
  topicSubscribers.get(normalizedTopic).add(ws);
  ws.subscriptions.add(normalizedTopic);

  if (topicSubscribers.get(normalizedTopic).size === 1) {// only add RabbitMQ binding if this is the first subscriber for the topic on this node
    try {
      await bindTopicToNodeQueue(normalizedTopic);
    } catch (error) {
      removeLocalSubscription(ws, normalizedTopic);
      console.error(`Failed to bind topic "${normalizedTopic}" to RabbitMQ: ${error.message}`);
      sendSystemMessage(ws, `Unable to subscribe to "${normalizedTopic}" right now.`);
      return false;
    }
  }

  sendSystemMessage(ws, `Subscribed to "${normalizedTopic}".`);
  return true;
}

async function unsubscribeClient(ws, topic) {
  const normalizedTopic = normalizeTopic(topic);

  if (!normalizedTopic) {
    sendSystemMessage(ws, 'Topic name is required.');
    return false;
  }

  if (!ws.subscriptions.has(normalizedTopic)) {
    sendSystemMessage(ws, `Not subscribed to "${normalizedTopic}".`);
    return false;
  }

  const removedLastSubscriber = removeLocalSubscription(ws, normalizedTopic);

  if (removedLastSubscriber) {
    try {
      await unbindTopicFromNodeQueue(normalizedTopic);
    } catch (error) {
      console.error(`Failed to unbind topic "${normalizedTopic}" from RabbitMQ: ${error.message}`);
    }
  }

  sendSystemMessage(ws, `Unsubscribed from "${normalizedTopic}".`);
  return true;
}

async function publishToTopic(ws, topic, message) {
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

  if (!rabbitPublisherChannel) {
    sendSystemMessage(ws, 'Message bus is unavailable.');
    return;
  }

  const formattedMessage = `[${normalizedTopic}] ${ws.userName}: ${text}`;
  console.log(`Received: ${formattedMessage}`);


  // publish to RabbitMQ so it can be delivered to subscribers on this node as well as other nodes
  rabbitPublisherChannel.publish(
    RABBITMQ_EXCHANGE,
    normalizedTopic,// routing key is the topic
    Buffer.from(serializeBrokerMessage(normalizedTopic, formattedMessage, ws.userName)),
    {
      contentType: 'application/json',
      persistent: false,
    }
  );

  await rabbitPublisherChannel.waitForConfirms();
}

async function removeClientFromAllTopics(ws) {
  const topics = Array.from(ws.subscriptions);

  for (const topic of topics) {
    const removedLastSubscriber = removeLocalSubscription(ws, topic);

    if (removedLastSubscriber) {
      try {
        await unbindTopicFromNodeQueue(topic);
      } catch (error) {
        console.error(`Failed to unbind topic "${topic}" during disconnect: ${error.message}`);
      }
    }
  }
}

async function handleClientMessage(ws, rawMessage) {
  const text = rawMessage.toString().trim();

  if (!text) {
    return;
  }

  let payload;

  try {
    payload = JSON.parse(text);
  } catch (error) {
    await publishToTopic(ws, DEFAULT_TOPIC, text);
    return;
  }

  if (!payload || typeof payload !== 'object') {
    sendSystemMessage(ws, 'Unsupported message format.');
    return;
  }

  // parse action from payload and normalize it
  const action = typeof payload.action === 'string' ? payload.action.trim().toLowerCase() : '';

  if (action === 'subscribe') {
    await subscribeClient(ws, payload.topic);
    return;
  }

  if (action === 'unsubscribe') {
    await unsubscribeClient(ws, payload.topic);
    return;
  }

  if (action === 'publish') {
    await publishToTopic(ws, payload.topic, payload.message);
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

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Shutting down due to ${signal}.`);

  if (wss) {
    await new Promise((resolve) => wss.close(resolve));
  }

  if (rabbitPublisherChannel) {
    await rabbitPublisherChannel.close().catch(() => {});
  }

  if (rabbitSubscriberChannel) {
    await rabbitSubscriberChannel.close().catch(() => {});
  }

  if (rabbitConnection) {
    await rabbitConnection.close().catch(() => {});
  }

  process.exit(0);
}

async function startServer() {
  await initializeRabbitMq();

  wss = new WebSocket.Server({ port: PORT });
  console.log(`WebSocket server is running on ws://localhost:${PORT}`);

  wss.on('connection', async (ws, request) => {
    const requestUrl = new URL(request.url, `ws://localhost:${PORT}`);
    ws.userName = requestUrl.searchParams.get('name') || 'Anonymous';
    ws.subscriptions = new Set();

    console.log(`Client connected: ${ws.userName}`);

    ws.send(`Welcome, ${ws.userName}!`);

    try {
      await subscribeClient(ws, DEFAULT_TOPIC);
      sendSystemMessage(ws, 'Send JSON messages to subscribe, unsubscribe, publish, or list subscriptions.');
    } catch (error) {
      console.error(`Failed to initialize client ${ws.userName}: ${error.message}`);
      sendSystemMessage(ws, 'Server initialization failed for this connection.');
      ws.close();
      return;
    }

    ws.on('message', async (message) => {
      try {
        await handleClientMessage(ws, message);
      } catch (error) {
        console.error(`Failed to handle message from ${ws.userName}: ${error.message}`);
        sendSystemMessage(ws, 'Unable to process that message right now.');
      }
    });

    ws.on('close', async () => {
      try {
        await removeClientFromAllTopics(ws);
      } catch (error) {
        console.error(`Failed to clean up client ${ws.userName}: ${error.message}`);
      }

      console.log(`Client disconnected: ${ws.userName}`);
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error: ${error.message}`);
    });
  });

  wss.on('error', (error) => {
    console.error(`Server error: ${error.message}`);
  });
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error(`Shutdown failed: ${error.message}`);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error(`Shutdown failed: ${error.message}`);
    process.exit(1);
  });
});

startServer().catch((error) => {
  console.error(`Startup failed: ${error.message}`);
  process.exit(1);
});


