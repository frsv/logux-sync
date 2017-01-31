# Logux Sync

<img align="right" width="95" height="95" title="Logux logo"
     src="https://cdn.rawgit.com/logux/logux/master/logo.svg">

A tool for synchronizing actions between [Logux logs]. It could synchronize logs
on different machines through network, or on same machine.

Also it does authentication, actions filtering, timestamp fixing
and connection diagnostics.

Synchronization protocol specification: [`logux/protocol`].

In most use cases, you don’t need to create Sync, high-level Logux tools
will do it for you. But you will have access to Sync API from that tools.

```js
import BrowserConnection from 'logux-sync/browser-connection'
import ClientSync from 'logux-sync/client-sync'
import Reconnect from 'logux-sync/reconnect'

const connection = new BrowserConnection('wss://logux.example.com')
const reconnect  = new Reconnect(connection)
const sync = new ClientSync('user' + user.id + ':' + uuid, log1, connection, {
  subprotocol: [3, 0],
  credentials: user.token,
  outFilter: action => Promise.resolve(action.sync)
})

reconnect.connect()
```

```js
import { ServerSync, ServerConnection } from 'logux-sync'

wss.on('connection', function connection (ws) {
  const connection = new ServerConnection(ws)
  const sync = new ServerSync('server', log2, connection, {
    subprotocol: [3, 1],
    outFilter: action => access(action),
    auth: token => checkToken(token)
  })
})
```

[`logux/protocol`]: https://github.com/logux/logux-protocol
[Logux logs]:       https://github.com/logux/logux-core

<a href="https://evilmartians.com/?utm_source=logux-sync">
  <img src="https://evilmartians.com/badges/sponsored-by-evil-martians.svg"
       alt="Sponsored by Evil Martians" width="236" height="54">
</a>


## Connection

Logux protocol can work with any data encoding format (e.g. JSON or XML)
and via any data transfer channel (e.g. WebSockets Secure or AJAX
with HTTP “keep-alive”).

You can create special connection classes for different channels
and encoding formats and use them with Logux Sync.

```js
import BrowserConnection from 'logux-websocket/browser-connection'
const connection = new BrowserConnection(serverUrl)
const sync = new ClientSync(nodeId, log, connection, opts)
connection.connect()
```

Connection instance should provide `connect()` and `disconnect()`
methods and `connect`, `disconnect` and `message` events in [NanoEvents] API.

[NanoEvents]: https://github.com/ai/nanoevents


### WebSocket

Some old proxy servers may block unsafe WebSocket protocol.
It is one of the reasons why we highly recommend to use `wss://` over `ws://`.

WebSocket Secure is a “HTTPS” for WebSockets. First of all,
it increases user security. On the other hand, it also protects
you from proxy-related problems.


### Reconnect

Logux Sync has special wrapper classes, which automatically reestablish
lost connections:

```js
const reconnect = new Reconnect(connection, {
  minDelay: 0,
  attempts: 10
})
```


### Client and Server

There is not that much difference between `ClientSync` and `ServerSync`.
For one, the client will send `connect`, when connection will be started.
Also, the server will destroy itself after the connection is closed.

Messages are same for client and server. However, if you want
a different behaviour, you can take `BaseSync` class and make your own roles
(e.g. for a multi-master synchronization).


### Node ID

Node ID are used in the action ID generator and it uniqueness is very important
for correct timing and log synchronization.

Ensure using unique node IDs. For example, your back-end application may use
a counter to generate short and unique IDs. You can put this name
in a `<meta>` tag for using it in the client JS code.

If you can’t generate short unique IDs, [UUID] will be best way.

Current node ID will be saved to the `localNodeId` property. Remote node ID
will be saved to `remoteNodeId`.

```js
console.log('Start synchronization with ' + client.remoteNodeId)
```

[UUID]: https://github.com/broofa/node-uuid


### Subprotocol Versions

Subprotocol is an application protocol, which you build on top of Logux.
It consists of actions and expected reactions on them.

In future you may want to change some action types or options.
But some clients could still be using old code for some time after an update.

It’s a good reason to specify a subprotocol version in [SemVer] format
using Logux Sync.

```js
new ClientSync(nodeId, log, connection, {
  …
  subprotocol: '3.1.0'
})
```

Logux will send this version from the client to the server and from the server
to the client. Remote node subprotocol will be saved as `remoteSubprotocol`:

```js
if (!semver.satisfies(sync.remoteSubprotocol, '4.x')) {
  useOldAPI()
}
```

You can check if the subprotocol is supported in the `connect` event
and send a `wrong-subprotocol` response in case of a wrong subprotocol version:

```js
import SyncError from 'logux-sync/sync-error'
sync.on('connect', () => {
  if (!semver.satisfies(sync.remoteSubprotocol, '>= 4.0.0')) {
    throw new SyncError(sync, 'wrong-subprotocol', {
      supported: '>= 4.0.0',
      used: sync.remoteSubprotocol
    })
  }
})
```

[SemVer]: http://semver.org/


### Authentication

Authentication is built-in into Logux protocol. Both client and server
can have credentials data (yet in most use cases only client will have it).
Both can as well have an `auth` callback for authenticating.

```js
new ClientSync(nodeId, log, connection, {
  …
  credentials: user.token
})
```

Credentials can be stored as a string, number, object or an array.

Authentication callback should return a promise with `true` or `false`.
All messages from this node will wait until the authentication is finished.

```js
new ServerSync('server', log, connection, {
  …
  auth: token => {
    return findUserByToken(token).then(user => {
      return !!user
    })
  }
})
```


## Time Fixing

Some clients may have wrong time zone and fixed it by setting a wrong time.
Other client may have a small (±10 minutes) time mistake or just ignore
the computer’s time.

Nevertheless, the correct time is vitally important for CRDT and other log
based operations.

This is why you can enable time fixing using the `fixTime` option.
`ClientSync` enables it by default.

Logux Sync will calculate a round-trip time and compare client and server times
in order to calculate the time difference between them.

This fix will be applied to the actions `time` timestamps before sending them
to the server or receiving them from the server to a client log.


## State

At every moment, the client-server interaction can be in one of 5 possible states:

* `disconnected`: there is no connection, nor new actions for synchronization.
* `wait`: new actions are awaiting synchronization, but there is no connection.
* `connecting`: connection was established and we wait for the node's response.
* `sending`: new actions were sent, waiting for the answer.
* `synchronized`: all actions are synchronized, and the connection is active.

You can get the current state accessing the `state` property or subscribing
to it changes using the `state` event:

```js
client.on('state', () => {
  if (client.state === 'wait' || client.state === 'sending') {
    doNotCloseBrowser()
  } else {
    allowToCloseBrowser()
  }
})
```


## Synchronization

After receiving `connect` and `connected` messages,
nodes will synchronize actions.

Every node has `lastSent` and `lastReceived` properties. They contain the latest
`added` time of sent and received actions.

If the node will go offline, `lastSent` and `lastReceived` properties will
be used on the next connection for finding new actions for synchronization.

In most cases, you don’t need to synchronize all actions.
Some client actions are local (like clicks or animation updates).
Some server actions, however, are now allowed to be shown for every client.

So client and server have `inFilter` and `outFilter` options. This callbacks
should return Promises resolving with `true` or `false`.

In the `outFilter`, you can specify the action to send:

```js
new ClientSync(nodeId, log, connection, {
  …
  outFilter: action => Promise.resolve(action.sync)
})
```

In the `inFilter` you can specify the actions to be received:

```js
new ServerSync(nodeId, log, connection, {
  …
  inFilter: action => doesUserHaveWriteAccess(action)
})
```

Also, you can change actions before sending or adding them to the log
using `inMap` and `outMap` options.


## Diagnostics

Sometimes the connection can go down without emitting a `disconnected` event.
So there is an explicit answer for every message in order to ensure that
it was received.

You can set a milliseconds `timeout` option and if the answer will not received
after this time, Logux Sync will close the connection and throw an error.

```js
new ClientSync(nodeId, log, connection, {
  …
  timeout: 5000
})
```

To be sure that connection is working and you get the latest state
from the server, Logux Sync can send `ping` messages. Set milliseconds `ping`
option specifying how often it should test the connection:

```js
new ClientSync(nodeId, log, connection, {
  …
  timeout: 5000,
  ping: 10000
})
```

All synchronization errors will be thrown to be shown in the terminal.
You can process this errors and disable throwing by `catch()` method:

```js
client.catch(error => {
  showSyncError(error)
})
```


## Finishing

When you will not need synchronization, call the `destroy()` method.
It will remove every listener and disable the synchronization.


## Tests

`LocalPair` is a loopback connection pair synchronization on the same machine.

```js
import { LocalPair } from 'logux-sync'
const pair = new LocalPair()
const client = new ClientSync('client', log1, pair.left)
const server = new ServerSync('server', log2, pair.right)
```

But we also have special `TestPair` with test helpers:

```js
import { TestPair } from 'logux-sync'

it('should send messages', () => {
  const pair = new TestPair()
  const client = new ClientSync('client', log1, pair.left)

  pair.right.connect()
  return pair.wait().then(() => {
    expect(pair.right.connected).toBeTruthy()
    return pair.wait()
  }).then(() => {
    expect(pair.leftSent).toEqual([
      ['connect', …]
    ])
  })
})
```
