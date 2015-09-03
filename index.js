var xtend = require('xtend')
var inherits = require('util').inherits
var EventEmitter = require('events').EventEmitter
var ginga = require('ginga')
var semaphore = require('./semaphore')
var levelErrors = require('level-errors')
var Codec = require('level-codec')
var error = require('./error')
var params = ginga.params

function Transaction (db, opts) {
  if (!(this instanceof Transaction)) {
    return new Transaction(db, opts)
  }
  if (db.toString() !== 'LevelUP') {
    throw new Error('db must be LevelUP or SublevelUP instance.')
  }
  this.db = db
  if (typeof db.sublevel === 'function' && db.options.db) {
    // all sublevels share same leveldown constructor
    db.options.db._shared = db.options.db._shared || {}
    this._shared = db.options.db._shared
  } else {
    db._shared = db._shared || {}
    this._shared = db._shared
  }

  this.options = xtend({
    ttl: 20 * 1000
  }, db.options, opts)

  this._released = false

  this._codec = new Codec(this.options)
  this._taken = {}
  this._map = {}
  this._notFound = {}
  this._batch = []

  EventEmitter.call(this)
  this.setMaxListeners(Infinity)

  this._q = this._q || [semaphore(1)]
  this._error = null

  this._timeout = setTimeout(
    this.rollback.bind(this, error.TX_TIMEOUT),
    this.options.ttl
  )
}

inherits(Transaction, EventEmitter)

function pre (ctx, next) {
  if (this._released) return next(this._error || error.TX_RELEASED)
  next()
}

function lock (ctx, next) {
  var self = this

  // options object
  ctx.options = xtend(this.options, ctx.params.opts)

  // sublevel prefix
  if (ctx.options && ctx.options.prefix &&
    typeof ctx.options.prefix.sublevel === 'function') {
    ctx.sublevel = ctx.options.prefix
    ctx.hash = ctx.sublevel.prefix
  } else {
    ctx.sublevel = null
    ctx.hash = this.db.prefix || ''
  }

  // key + sublevel prefix hash
  // hash must not collide with key
  if (ctx.params.hash) {
    ctx.hash += '!h!' + String(this._codec.encodeKey(ctx.params.hash, ctx.options))
  } else if (ctx.params.key) {
    ctx.hash += '!k!' + String(this._codec.encodeKey(ctx.params.key, ctx.options))
  }

  this.defer(function (cb) {
    if (self._released) return

    ctx.on('end', cb)

    if (self._taken[ctx.hash]) {
      next()
    } else {
      // gain mutually exclusive access to transaction
      var mu = self._shared[ctx.hash] = self._shared[ctx.hash] || semaphore(1)
      mu.take(function () {
        if (self._released) {
          mu.leave()
          return
        }
        self._taken[ctx.hash] = true
        next()
      })
    }
  })

}

function abort (ctx) {
  this._error = ctx.params.error
}

function get (ctx, done) {
  var self = this
  if (this._notFound[ctx.hash]) {
    return done(new levelErrors.NotFoundError(
      'Key not found in transaction [' + ctx.params.key + ']'
    ))
  }
  if (ctx.hash in this._map) {
    return done(null, this._codec.decodeValue(
      this._map[ctx.hash], ctx.options))
  }
  (ctx.sublevel || this.db).get(ctx.params.key, ctx.options, function (err, val) {
    if (self._released) return
    if (err && err.notFound) {
      self._notFound[ctx.hash] = true
      delete self._map[ctx.hash]
    } else {
      self._map[ctx.hash] = self._codec.encodeValue(val, ctx.options)
    }
    done(err, val)
  })
}

function put (ctx, done) {
  var enKey = this._codec.encodeKey(ctx.params.key, ctx.options)
  var enVal = this._codec.encodeValue(ctx.params.value, ctx.options)
  this._batch.push(xtend(ctx.options, {
    type: 'put',
    key: enKey,
    value: enVal,
    keyEncoding: 'utf8',
    valueEncoding: 'utf8'
  }))

  this._map[ctx.hash] = enVal
  delete this._notFound[ctx.hash]

  this.emit('put', ctx.params.key, ctx.params.value)

  done(null)
}

function del (ctx, done) {
  var enKey = this._codec.encodeKey(ctx.params.key, ctx.options)
  this._batch.push(xtend(ctx.options, {
    type: 'del',
    key: enKey,
    keyEncoding: 'utf8'
  }))

  delete this._map[ctx.hash]
  this._notFound[ctx.hash] = true

  this.emit('del', ctx.params.key)

  done(null)
}

function commit (ctx, next) {
  var self = this
  var done = false

  ctx.on('end', function (err) {
    // rollback on commit error
    if (err) self.rollback(err)
  })
  this.on('release', function (err) {
    if (!done) next(err)
  })
  var last = this._q[0]
  last.take(function () {
    last.leave()
    done = true
    if (self._released) return
    if (self._error) return next(self._error)
    self.db.batch(self._batch, function (err, res) {
      if (err) next(err)
      else next()
    })
  })
}

// release after rollback, commit
function release (ctx, done) {
  clearTimeout(this._timeout)

  for (var hash in this._taken) {
    this._shared[hash].leave()
    if (this._shared[hash].empty()) delete this._shared[hash]
  }

  delete this.options
  delete this._codec
  delete this._taken
  delete this._map
  delete this._batch
  delete this._notFound

  this._released = true
  this.emit('close', this._error)
  this.emit('release', this._error)
  this.emit('end', this._error)
  done(this._error)
}

ginga(Transaction.prototype)
  .define('lock', params('hash', 'opts?'), pre, lock)
  .define('get', params('key', 'opts?'), pre, lock, get)
  .define('put', params('key', 'value', 'opts?'), pre, lock, put)
  .define('del', params('key', 'opts?'), pre, lock, del)
  .define('rollback', params('error?'), pre, abort, release)
  .define('commit', pre, commit, release)

Transaction.prototype.defer = function (fn) {
  var self = this
  var sema = this._q[this._q.length - 1]
  sema.take(function () {
    if (self._error) {
      return sema.leave()
    }
    self._q.push(semaphore(1))
    fn(function (err) {
      // notFound err wont block queue
      if (err && !err.notFound) {
        self._error = err
      }
      var sema2 = self._q.pop()
      sema2.take(function () {
        sema2.leave()
        sema.leave()
      })
    })
  })
  return this
}

module.exports = Transaction
