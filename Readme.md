# Multi Node WebSocket Server

## Content
- [About](#about)
- [Architecture Explanation](#architecture-explanation)
- [Client Testing](#client-testing)
- [Deploy and Test](#deploy-and-test)

<br>

---

# About

A Node.js WebSocket server using the `ws` library and `RabbitMQ` for multi-node fan-out.

**Why do we need this?** Say we have a chat app that connects to a WebSocket server. The websocket connection is stateful, i.e the server needs to remember which clients are subscribed to which topics. If we want to scale this app horizontally across multiple server instances, we need a way for those instances to share topic membership and publish messages to each other. 

**Example:** Alice connects to Node 1 and subscribes to `sports`. Bob connects to Node 2 and also subscribes to `sports`. If Alice publishes a message to `sports`, how does that message get to Bob if they are connected to different server nodes?

**Solution:** We use RabbitMQ as the message broker. On server start, the server connects to RabbitMQ and creates a unique queue for that node in RabbitMQ. When a client subscribes to a topic ( or a room ) on that node, the server binds its queue to that topic. When a message is published to a topic, RabbitMQ fans it out to every server node that has its queue bound to the topic. Each server node then forwards the message only to its own local clients for that topic.

This way we can run multiple instances of this WebSocket server, and ensure all the clients receive the messages regardless of which node they are connected to.

<br>

---

# Architecture Explanation

### Server Behavior

| Behavior | Detail |
|---|---|
| On connect | Client receives a welcome message and is subscribed to `lobby` |
| Subscriptions | Clients can subscribe or unsubscribe from topics at any time |
| State | Each node keeps only its own local WebSocket connections in memory |
| Plain text messages | Treated as a publish to the default `lobby` topic |
| Cross-node messaging | Handled exclusively via RabbitMQ — nodes never talk directly to each other |

### RabbitMQ Delivery Model

Each node owns one exclusive RabbitMQ queue. Topic bindings on that queue are added and removed dynamically as local clients subscribe and unsubscribe.

**Server startup:** When a node starts, it connects to RabbitMQ and creates a unique, exclusive queue for itself. This queue serves as the node's message inbox for all topics its clients are subscribed to.

**Client joins a topic (binding process):** When a client subscribes to a topic on a node, the server immediately binds that node's queue to the topic's routing key in RabbitMQ. This tells RabbitMQ to start routing messages with that topic to this node's queue. If multiple clients on the same node subscribe to the same topic, the binding only happens once (the binding is already in place).

**Message flow (client publish → all subscribers):**

1. Client sends a `publish` action to its connected node.
2. That node publishes once to the RabbitMQ topic exchange.
3. RabbitMQ copies the message to every node queue bound to that topic.
4. Each node consumes from its own queue and forwards the message to its local subscribers.

**Why bindings are dynamic — topic `sports` example:**

Node 2 only binds its queue to `sports` *while* Bob (a local client) is subscribed. When Bob unsubscribes, Node 2 removes the binding to stop wasting broker resources:

```text
State 1: Both nodes have subscribers
  Node 1 queue ← sports
  Node 2 queue ← sports

State 2: Bob unsubscribes (Node 2's only sports subscriber)
  Node 1 queue ← sports
  Node 2 queue ← (removed: no local subscribers)
```

After unbinding, new `sports` publishes only go to Node 1's queue.

### State Layout

The server maintains two complementary data structures in memory:

| Structure | Location | Purpose |
|---|---|---|
| `topicSubscribers` | On the server | Map: topic → all local WebSocket clients subscribed to it |
| `ws.subscriptions` | On each client connection | Set: all topics that client has joined |

**Why two structures?** One answers "who's subscribed to topic X?" and the other answers "what topics is client Y in?"

**Example state** after Alice (Node 1) and Bob (Node 2) both subscribe to `sports`:

```js
// Server-level maps
node1.topicSubscribers = { lobby: Set(wsAlice), sports: Set(wsAlice) }
node2.topicSubscribers = { lobby: Set(wsBob),   sports: Set(wsBob)   }

// Per-connection sets ( inside the server )
wsAlice.subscriptions = Set('lobby', 'sports')
wsBob.subscriptions   = Set('lobby', 'sports')

// RabbitMQ queue bindings
node1Queue → ['lobby', 'sports']
node2Queue → ['lobby', 'sports']
```


### Message Protocol

The server accepts two types of client messages:

**1. Simple messaging** — Plain text messages are automatically published to the `lobby` topic and delivered to all connected clients.

**2. Topic-based messaging** — Send JSON messages to join/leave topics or broadcast to a specific audience:

| Action | Purpose | Example |
|---|---|---|
| `subscribe` | Join a topic to receive all messages sent to it | `{ "action": "subscribe", "topic": "sports" }` |
| `unsubscribe` | Leave a topic and stop receiving its messages | `{ "action": "unsubscribe", "topic": "sports" }` |
| `publish` | Send a message to a specific topic | `{ "action": "publish", "topic": "sports", "message": "Hello room" }` |
| `list` | Get all topics you're currently subscribed to | `{ "action": "list" }` |

### Example Topic Flow

This example shows the same topic named `sports`, but with the two clients connected to different WebSocket nodes. The local WebSocket nodes do not talk to each other directly. RabbitMQ is the bridge between them.

```mermaid
sequenceDiagram
        box Node 1
            participant A as Client A (Alice)
            participant S1 as WebSocket Node 1
        end

        participant MQ as RabbitMQ Topic Exchange

        box Node 2
            participant S2 as WebSocket Node 2
            participant B as Client B (Bob)
        end

        A->>S1: Connect with ?name=Alice
        S1-->>A: Welcome, Alice!
        S1-->>A: System: Subscribed to "lobby"

        B->>S2: Connect with ?name=Bob
        S2-->>B: Welcome, Bob!
        S2-->>B: System: Subscribed to "lobby"

        A->>S1: { action: "subscribe", topic: "sports" }
        S1->>MQ: Bind Node 1 queue to routing key sports
        S1-->>A: System: Subscribed to "sports"

        B->>S2: { action: "subscribe", topic: "sports" }
        S2->>MQ: Bind Node 2 queue to routing key sports
        S2-->>B: System: Subscribed to "sports"

        A->>S1: { action: "publish", topic: "sports", message: "Hello" }
        S1->>MQ: Publish message with routing key sports
        MQ-->>S1: Deliver to Node 1 queue
        MQ-->>S2: Deliver to Node 2 queue
        S1-->>A: [sports] Alice: Hello
        S2-->>B: [sports] Alice: Hello

        B->>S2: { action: "unsubscribe", topic: "sports" }
        S2->>MQ: Unbind sports if Bob was last local subscriber
        S2-->>B: System: Unsubscribed from "sports"

        A->>S1: { action: "publish", topic: "sports", message: "Still there?" }
        S1->>MQ: Publish message with routing key sports
        MQ-->>S1: Deliver to Node 1 queue
        S1-->>A: [sports] Alice: Still there?
```

left to right flow:

1. Each node keeps only its own local client connections.
2. Each node binds its RabbitMQ queue to a topic only when that node has at least one local subscriber for that topic.
3. Publishing goes to RabbitMQ once.
4. RabbitMQ fans the message out to every node queue currently bound to that topic.
5. Each node then sends the message only to its own connected clients for that topic.


<br>

---

# Client Testing

You can test the WebSocket server using the browser client in the project root or any WebSocket client that can send JSON payloads.

A full browser client is included in `index.html` in this repository. You can run this by using python ( python3 -m http.server ), or node ( npx http-server ) to serve the file and then opening it in your browser ( localhost:8080 ).

Browser flow:

- Enter the WebSocket server URL (or use the default Railway URL)
- Enter your name and click **Join** to connect
- Subscribe to a topic such as `sports`, think of this as joining a chat room
- Open a second browser tab, enter a different name, and subscribe to the same topic
- Send a message to that topic and only subscribers to that topic will receive it
- Unsubscribe from the topic and verify new messages stop arriving

<br>

---

## Testing

To test cross-node messaging, you need at least two server instances connected to the same RabbitMQ instance. The steps below use Railway to deploy them, but any hosting provider works.

### 1. Deploy RabbitMQ

1. Go to Railway dashboard → **New Project** → **Deploy from Docker Image**
2. Enter image: `rabbitmq:3-management`
3. Set environment variables:
   - `RABBITMQ_DEFAULT_USER=admin`
   - `RABBITMQ_DEFAULT_PASS=strongpassword`
   - `RABBITMQ_DEFAULT_VHOST=/` (allows multiple apps to coexist)
4. *(Optional)* For the management UI, create a public URL in **Settings → Network** and expose port `15672`
5. Add a volume at `/var/lib/rabbitmq` for data persistence:
   - On the dashboard, create a new volume
   - Select the RabbitMQ instance
   - Add the path `/var/lib/rabbitmq` and deploy

### 2. Deploy Server Instances

For each server instance (repeat steps for Server 1 and Server 2):

1. Create a new service → **Deploy from Git** (select this repo)
2. Railway auto-detects the Dockerfile and builds the image
3. In **Settings → Network**, create a public URL (you'll need this for client testing)
4. In **Variables**, add:
   - `RABBITMQ_URL=amqp://admin:strongpassword@rabbitmq.railway.internal:5672`
   - (Replace hostname with your RabbitMQ internal URL if different, you can find this in the RabbitMQ service's network settings)
5. Deploy the service

Repeat the same steps and create a second server instance to test multi-node messaging.
After these steps, you should have two WebSocket server instances running, with their own public URLs, both connected to the same RabbitMQ instance.

![Alt text](../images/rabbitMq/1.png)  <!-- showing rabbitmq and two server instances in railway dashboard -->

### 3. Test with the Browser Client

A full browser client is included in `index.html` in the [repository](https://github.com/Tarun-Elango/Node-WebSocket-Server-with-RabbitMQ). Serve it locally using Python (`python3 -m http.server`) or Node (`npx http-server`), then open `http://localhost:8000` in your browser.

1. Enter the public URL of Server 1 (e.g., `wss://your-server-1-url.railway.app`), enter your name, and click **Join**
2. Open a second tab, connect to Server 2's public URL with a different name, and click **Join**
3. Subscribe to the same topic (e.g., `sports`) in both tabs
4. Send a message from one tab — it will appear in the other, proving cross-node communication works
5. Unsubscribe from the topic in one tab and verify new messages stop arriving there

Check server logs to verify that RabbitMQ is routing messages and that topic bindings are dynamically added/removed as clients subscribe/unsubscribe.