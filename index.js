var BrowserConnection = require('./browser-connection')
var ServerConnection = require('./server-connection')
var ClientSync = require('./client-sync')
var ServerSync = require('./server-sync')
var LocalPair = require('./local-pair')
var SyncError = require('./sync-error')
var Reconnect = require('./reconnect')
var BaseSync = require('./base-sync')
var TestPair = require('./test-pair')

module.exports = {
  BrowserConnection: BrowserConnection,
  ServerConnection: ServerConnection,
  ClientSync: ClientSync,
  ServerSync: ServerSync,
  LocalPair: LocalPair,
  SyncError: SyncError,
  Reconnect: Reconnect,
  BaseSync: BaseSync,
  TestPair: TestPair
}

/**
 * Logux protocol message. It is a array with string of message type in first
 * position and strings/numbers/objects or arrays in next positions.
 *
 * @typedef {Array} Message
 * @property {string} 0 Message type
 */

/**
 * Abstract interface for connection to synchronize logs over it.
 * For example, WebSocket or Loopback.
 *
 * @name Connection
 * @class
 * @abstract
 */
/**
 * Send message to connection.
 *
 * @param {Message} message The message to be sent.
 *
 * @return {undefined}
 *
 * @name send
 * @function
 * @memberof Connection#
 */
/**
 * Subscribe for connection events. It implements nanoevents API.
 * Supported events:
 *
 * * `connecting`: connection establishing was started.
 * * `connect`: connection was established by any side.
 * * `disconnect`: connection was closed by any side.
 * * `message`: message was receive from remote node.
 * * `error`: error during connection, sending or receiving.
 *
 * @param {"connecting"|"connect"|"disconnect"|"message"|"error"} event Event.
 * @param {function} listener The listener function.
 *
 * @return {function} Unbind listener from event.
 *
 * @name on
 * @function
 * @memberof Connection#
 */
/**
 * Start connection. Connection should be in disconnected state
 * from the beginning and start connection only on this method call.
 *
 * This method could be called again if connection moved to disconnected state.
 *
 * @return {Promise} Promise until connection will be established.
 *
 * @name connect
 * @function
 * @memberof Connection#
 */
/**
 * Finish current connection.
 *
 * After disconnection, connection could be started again
 * by {@link Connection#connect}.
 *
 * @return {undefined}
 *
 * @name disconnect
 * @function
 * @memberof Connection#
 */
/**
 * Is connection is enabled.
 *
 * @name connected
 * @type {boolean}
 * @memberof Connection#
 */
