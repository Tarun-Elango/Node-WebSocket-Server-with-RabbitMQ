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

**For example:** Alice connects to Node 1 and subscribes to `sports`. Bob connects to Node 2 and also subscribes to `sports`. If Alice publishes a message to `sports`, how does that message get to Bob if they are connected to different server nodes?

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

Clients can continue sending plain text messages, which will be published to the default `lobby` topic.

For room-based behavior, send JSON messages with one of these actions:

```json
{ "action": "subscribe", "topic": "sports" }
{ "action": "unsubscribe", "topic": "sports" }
{ "action": "publish", "topic": "sports", "message": "Hello room" }
{ "action": "list" }
```

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

# Deploy and Test the Server

Use Railway (or any cloud provider) to deploy the WebSocket server and RabbitMQ.

### 1. Deploy RabbitMQ

1. Go to Railway dashboard → **New Project** → **Deploy from Docker Image**
2. Enter image: `rabbitmq:3-management`
3. Set environment variables:
   - `RABBITMQ_DEFAULT_USER=admin`
   - `RABBITMQ_DEFAULT_PASS=strongpassword`
   - `RABBITMQ_DEFAULT_VHOST=/` (allows multiple apps to coexist)
4. *(Optional)* For the management UI, create a public URL in **Settings → Network** and expose port `15672`
5. Add a volume at `/var/lib/rabbitmq` for data persistence

### 2. Deploy Server Instances

For each server instance (repeat steps for Server 1 and Server 2):

1. Create a new service → **Deploy from Git** (select this repo)
2. Railway auto-detects the Dockerfile and builds the image
3. In **Settings → Network**, create a public URL (you'll need this for client testing)
4. In **Variables**, add:
   - `RABBITMQ_URL=amqp://admin:strongpassword@rabbitmq.railway.internal:5672`
   - (Replace hostname with your RabbitMQ service URL if different)
5. Deploy the service

Repeat for a second server instance to test multi-node messaging.

### 3. Test with the Client

1. Serve the `index.html` file locally:
   - Python: `python3 -m http.server`
   - Node: `npx http-server`
2. Open `http://localhost:8000` in your browser
3. Enter the public URL of Server 1 (e.g., `wss://your-server-1-url.railway.app`)
4. Enter your name and click **Join**
5. Open a second tab and connect to Server 2 with its public URL (e.g., `wss://your-server-2-url.railway.app`) using a different name
6. Subscribe to the same topic (e.g., `sports`) in both tabs
7. Send a message from one tab—it will appear in the other, proving cross-node communication works

Check server logs to verify that RabbitMQ is routing messages and that topic bindings are dynamically added/removed as clients subscribe/unsubscribe.
