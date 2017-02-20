var NanoEvents = require('nanoevents')
var assign = require('object-assign')

var SyncError = require('./sync-error')

var connectMessages = require('./messages/connect')
var errorMessages = require('./messages/error')
var pingMessages = require('./messages/ping')
var syncMessages = require('./messages/sync')

var validate = require('./validate')

var BEFORE_AUTH = ['connect', 'connected', 'error']

function syncMappedEvent (sync, action, meta) {
  if (sync.options.outMap) {
    sync.options.outMap(action, meta).then(function (changed) {
      sync.sendSync(changed[0], changed[1])
    })
  } else {
    sync.sendSync(action, meta)
  }
}

/**
 * Base methods for synchronization nodes. Client and server nodes
 * are based on this module.
 *
 * @param {string|number} nodeId Unique current machine name.
 * @param {Log} log Logux log instance to be synchronized.
 * @param {Connection} connection Connection to remote node.
 * @param {object} [options] Synchronization options.
 * @param {object} [options.credentials] Client credentials.
 *                                       For example, access token.
 * @param {authCallback} [options.auth] Function to check client credentials.
 * @param {boolean} [options.fixTime=false] Detect difference between client
 *                                          and server and fix time
 *                                          in synchronized actions.
 * @param {number} [options.timeout=0] Timeout in milliseconds to wait answer
 *                                     before disconnect.
 * @param {number} [options.ping=0] Milliseconds since last message to test
 *                                  connection by sending ping.
 * @param {filter} [options.inFilter] Function to filter actions
 *                                    from remote node. Best place
 *                                    for access control.
 * @param {mapper} [options.inMap] Map function to change remote node’s action
 *                                 before put it to current log.
 * @param {filter} [options.outFilter] Filter function to select actions
 *                                     to synchronization.
 * @param {mapper} [options.outMap] Map function to change action
 *                                  before sending it to remote client.
 * @param {string} [options.subprotocol] Application subprotocol version
 *                                       in SemVer format.
 *
 * @abstract
 * @class
 */
function BaseSync (nodeId, log, connection, options) {
  /**
   * Unique current machine name.
   * @type {string|number}
   *
   * @example
   * console.log(sync.localNodeId + ' is started')
   */
  this.localNodeId = nodeId
  /**
   * Log for synchronization.
   * @type {Log}
   */
  this.log = log
  /**
   * Connection used to communicate to remote node.
   * @type {Connection}
   */
  this.connection = connection
  /**
   * Synchronization options.
   * @type {object}
   */
  this.options = options || { }

  if (this.options.ping && !this.options.timeout) {
    throw new Error('You must set timeout option to use ping')
  }

  /**
   * Is synchronization in process.
   * @type {boolean}
   *
   * @example
   * sync.on('disconnect', () => {
   *   sync.connected //=> false
   * })
   */
  this.connected = false

  /**
   * Did we finish remote node authentication.
   * @type {boolean}
   */
  this.authenticated = false
  this.authenticating = false
  this.unauthenticated = []

  this.timeFix = 0
  this.syncing = 0
  this.received = { }

  /**
   * Latest current log `added` time, which was successfully synchronized.
   * It will be saves in log store.
   * @type {number}
   */
  this.lastSent = 0
  /**
   * Latest remote node’s log `added` time, which was successfully synchronized.
   * It will be saves in log store.
   * @type {number}
   */
  this.lastReceived = 0

  /**
   * Current synchronization state.
   *
   * * `disconnected`: no connection, but no new actions to synchronization.
   * * `wait`: new actions for synchronization but there is no connection.
   * * `connecting`: connection was established and we wait for node answer.
   * * `sending`: new actions was sent, waiting for answer.
   * * `synchronized`: all actions was synchronized and we keep connection.
   *
   * @type {"disconnected"|"wait"|"connecting"|"sending"|"synchronized"}
   *
   * @example
   * sync.on('state', () => {
   *   if (sync.state === 'wait' && sync.state === 'sending') {
   *     console.log('Do not close browser')
   *   }
   * })
   */
  this.state = 'disconnected'

  this.emitter = new NanoEvents()
  this.timeouts = []
  this.throwsError = true

  this.unbind = []
  var sync = this
  this.unbind.push(log.on('add', function (action, meta) {
    sync.onAdd(action, meta)
  }))
  this.unbind.push(connection.on('connecting', function () {
    sync.onConnecting()
  }))
  this.unbind.push(connection.on('connect', function () {
    sync.onConnect()
  }))
  this.unbind.push(connection.on('message', function (message) {
    sync.onMessage(message)
  }))
  this.unbind.push(connection.on('error', function (error) {
    if (error.message === 'Wrong message format') {
      sync.sendError(new SyncError(sync, 'wrong-format', error.received))
    } else {
      sync.error(error)
    }
    sync.connection.disconnect('error')
  }))
  this.unbind.push(connection.on('disconnect', function () {
    sync.onDisconnect()
  }))

  this.lastAddedCache = 0
  this.initializing = this.initialize()
}

BaseSync.prototype = {

  /**
   * Unique name of remote machine.
   * It is undefined until nodes handshake.
   *
   * @type {string|number|undefined}
   *
   * @example
   * console.log('Connected to ' + sync.remoteNodeId)
   */
  remoteNodeId: undefined,

  /**
   * Array with major and minor versions of used protocol.
   * @type {Version}
   *
   * @example
   * if (tool.sync.localProtocol[0] !== 1) {
   *   throw new Error('Unsupported Logux protocol')
   * }
   */
  localProtocol: [0, 1],

  /**
   * Array with major and minor versions of remote node protocol.
   * @type {Version|undefined}
   *
   * @example
   * if (sync.remoteProtocol[1] >= 5) {
   *   useNewAPI()
   * } else {
   *   useOldAPI()
   * }
   */
  remoteProtocol: undefined,

  /**
   * Remote node’s application subprotocol version in SemVer format.
   *
   * It is undefined until nodes handshake. If remote node will not send
   * on handshake its subprotocol, it will be set to `0.0.0`.
   *
   * @type {string|undefined}
   *
   * @example
   * if (semver.satisfies(sync.remoteSubprotocol, '>= 5.0.0') {
   *   useNewAPI()
   * } else {
   *   useOldAPI()
   * }
   */
  remoteSubprotocol: undefined,

  /**
   * Subscribe for synchronization events. It implements nanoevents API.
   * Supported events:
   *
   * * `state`: synchronization state was changed.
   * * `connect`: custom check before node authentication. You can throw
   *              a {@link SyncError} to send error to remote node.
   * * `error`: synchronization error was raised.
   * * `clientError`: when error was sent to remote node.
   *
   * @param {"state"|"connect"|"error"|"clientError"} event The event name.
   * @param {listener} listener The listener function.
   *
   * @return {function} Unbind listener from event.
   *
   * @example
   * sync.on('clientError', error => {
   *   logError(error)
   * })
   */
  on: function on (event, listener) {
    return this.emitter.on(event, listener)
  },

  /**
   * Add one-time listener for synchronization events.
   * See {@link BaseSync#on} for supported events.
   *
   * @param {"state"|"connect"|"error"|"clientError"} event The event name.
   * @param {listener} listener The listener function.
   *
   * @return {function} Unbind listener from event.
   *
   * @example
   * sync.once('clientError', () => {
   *   everythingFine = false
   * })
   */
  once: function once (event, listener) {
    return this.emitter.once(event, listener)
  },

  /**
   * Disable throwing a error on error message and create error listener.
   *
   * @param {errorListener} listener The listener function.
   *
   * @return {undefined}
   *
   * @example
   * sync.catch(error => {
   *   console.error(error)
   * })
   */
  catch: function (listener) {
    this.throwsError = false
    this.on('error', listener)
  },

  /**
   * Return Promise until {@link BaseSync#state} will be changed
   * to specific value.
   *
   * @param {string} state The expected synchronization state value.
   *
   * @return {Promise} Promise until specific state.
   *
   * @example
   * sync.waitFor('synchronized').then(() => {
   *   console.log('Everything is synchronized')
   * })
   */
  waitFor: function (state) {
    var sync = this
    return new Promise(function (resolve) {
      var unbind = sync.on('state', function () {
        if (sync.state === state) {
          unbind()
          resolve()
        }
      })
    })
  },

  /**
   * Shut down the connection and unsubscribe from log events.
   *
   * @return {undefined}
   *
   * @example
   * connection.on('disconnect', () => {
   *   server.destroy()
   * })
   */
  destroy: function destroy () {
    if (this.connection.destroy) {
      this.connection.destroy()
    } else if (this.connected) {
      this.connection.disconnect('destroy')
    }
    for (var i = 0; i < this.unbind.length; i++) {
      this.unbind[i]()
    }
  },

  send: function send (msg) {
    if (this.connected) {
      this.delayPing()
      this.connection.send(msg)
    } else {
      var json = JSON.stringify(msg)
      throw new Error('Could not send ' + json + ' to disconnected connection')
    }
  },

  onConnecting: function onConnecting () {
    this.setState('connecting')
  },

  onConnect: function onConnect () {
    this.delayPing()
    this.connected = true
  },

  onDisconnect: function onDisconnect () {
    this.endTimeout()
    if (this.pingTimeout) clearTimeout(this.pingTimeout)
    this.connected = false

    if (this.lastAddedCache > this.lastSent) {
      this.setState('wait')
    } else {
      this.setState('disconnected')
    }
  },

  onMessage: function onMessage (msg) {
    this.delayPing()

    if (!validate(this, msg)) return
    var name = msg[0]

    if (!this.authenticated && BEFORE_AUTH.indexOf(name) === -1) {
      if (this.authenticating) {
        this.unauthenticated.push(msg)
      } else {
        this.sendError(new SyncError(this, 'missed-auth', JSON.stringify(msg)))
      }
      return
    }

    var args = new Array(msg.length - 1)
    for (var i = 1; i < msg.length; i++) {
      args[i - 1] = msg[i]
    }
    this[name + 'Message'].apply(this, args)
  },

  onAdd: function onAdd (action, meta) {
    if (!this.connected) {
      this.setState('wait')
      return
    }
    if (this.lastAddedCache < meta.added) {
      this.lastAddedCache = meta.added
    }

    if (this.received[meta.id.join('\t')]) {
      delete this.received[meta.id.join('\t')]
      return
    }

    if (this.options.outFilter) {
      var sync = this
      this.options.outFilter(action, meta).then(function (result) {
        if (result) syncMappedEvent(sync, action, meta)
      })
    } else {
      syncMappedEvent(this, action, meta)
    }
  },

  syncError: function syncError (type, options, received) {
    var err = new SyncError(this, type, options, received)
    this.error(err)
  },

  error: function error (err) {
    this.emitter.emit('error', err)
    if (this.throwsError) {
      throw err
    }
  },

  setState: function setState (state) {
    if (this.state !== state) {
      this.state = state
      this.emitter.emit('state')
    }
  },

  startTimeout: function startTimeout () {
    if (!this.options.timeout) return

    var ms = this.options.timeout
    var sync = this
    var timeout = setTimeout(function () {
      if (sync.connected) sync.connection.disconnect('timeout')
      sync.syncError('timeout', ms)
    }, ms)

    this.timeouts.push(timeout)
  },

  endTimeout: function endTimeout () {
    if (this.timeouts.length > 0) {
      clearTimeout(this.timeouts.shift())
    }
  },

  delayPing: function delayPing () {
    if (!this.options.ping) return
    if (this.pingTimeout) clearTimeout(this.pingTimeout)

    var sync = this
    this.pingTimeout = setTimeout(function () {
      if (sync.connected) sync.sendPing()
    }, this.options.ping)
  },

  syncSince: function syncSince (lastSynced) {
    var data = []
    var sync = this
    this.log.each({ order: 'added' }, function (action, meta) {
      if (meta.added <= lastSynced) {
        return false
      } else {
        data.push(action, meta)
        return true
      }
    }).then(function () {
      if (!sync.connected) return
      if (data.length > 0) {
        sync.sendSync.apply(sync, data)
      } else {
        sync.setState('synchronized')
      }
    })
  },

  setLastSent: function setLastSent (value) {
    if (this.lastSent < value) this.lastSent = value
    this.log.store.setLastSynced({ sent: value })
  },

  setLastReceived: function setLastReceived (value) {
    if (this.lastReceived < value) this.lastReceived = value
    this.log.store.setLastSynced({ received: value })
  },

  now: function now () {
    return Date.now()
  },

  initialize: function initialize () {
    var sync = this
    return Promise.all([
      this.log.store.getLastSynced(),
      this.log.store.getLastAdded()
    ]).then(function (result) {
      sync.lastSent = result[0].sent
      sync.lastReceived = result[0].received
      sync.lastAddedCache = result[1]

      if (sync.lastAddedCache > sync.lastSent) sync.setState('wait')
      if (sync.connection.connected) sync.onConnect()
    })
  },

  sendDuilian: function sendDuilian (num) {
    var starts = Object.keys(DUILIANS)
    if (typeof num === 'undefined') {
      num = Math.floor(Math.random() * starts.length)
    }
    this.send(['duilian', starts[num]])
  },

  duilianMessage: function duilianMessage (line) {
    if (DUILIANS[line]) {
      this.send(['duilian', DUILIANS[line]])
    }
  },

  sendDebug: function sendDebug (message) {
    this.send(['debug', message])
  }

}

var DUILIANS = {
  '世事洞眀皆學問': '人情練達即文章',
  '書山有路勤爲徑': '學海無涯苦作舟'
}

BaseSync.prototype = assign(BaseSync.prototype,
  errorMessages, connectMessages, pingMessages, syncMessages)

module.exports = BaseSync

/**
 * Logux protocol version.
 *
 * @typedef {number[]} Version
 */

/**
 * @callback errorListener
 * @param {string} error The error description.
 */

/**
 * @callback authCallback
 * @param {object} credentials Remote node credentials.
 * @param {string} nodeId Unique ID of remote sync instance.
 * @return {Promise} Promise with boolean value.
 */

/**
 * @callback filter
 * @param {Action} action New action from log.
 * @param {Meta} meta New action metadata.
 * @return {Promise} Promise with `true` if action should be synchronized
 *                   with remote log.
 */

/**
 * @callback mapper
 * @param {Action} action New action from log.
 * @param {Meta} meta New action metadata.
 * @return {Promise} Promise with array of changed action and changed metadata.
 */
