var _ = require('underscore');

function hash(key, opts){
  var prefix = 0;
  if(opts && opts.prefix && _.isFunction(opts.prefix.prefix))
    prefix = opts.prefix.prefix();
  return JSON.stringify([prefix, key]);
}

module.exports = function( db ){
  var id       = 0;
  var locked   = {};

  function Transaction(){
    this.jobs = {};
    this.id = id.toString(36);
    id++;

    this.deps = {};
    this.map = {};
    this.batch = [];

  }
  var T = Transaction.prototype;

  T.get = function(key, opts, cb){
    cb = cb || opts || function(){};
    opts = _.isFunction(opts) ? null: opts;

    var self = this;
    var _db = opts && opts.prefix && _.isFunction(opts.prefix.get) ? opts.prefix : db;
    var hashed = hash(key, opts);

    if(this.map.hasOwnProperty(hashed))
      cb(null, this.map[hashed]);
    else
      this._lock(hashed, function(err){
        if(err) return cb(err);
        _db.get(key, opts, function(err, value){
          self.map[hashed] = value;
          cb(err, value);
        });
      });
    return this;
  };

  T.put = function(key, value, opts, cb){
    cb = cb || opts || function(){};

    this.batch.push(_.extend({
      type: 'put',
      key: key,
      value: value
    }, opts));

    this.map[ hash(key, opts) ] = value;

    cb(null);
    return this;
  };

  T.del = function(key, opts, cb){
    cb = cb || opts || function(){};

    this.batch.push(_.extend({
      type: 'del',
      key: key
    }, opts));

    delete this.map[ hash(key, opts) ];

    cb(null);
    return this;
  };

  T._lock = function(hash, job){
    job = job.bind(this);
    job.t = this;
    
    var i, j, l;

    if(locked[hash]){
      for(i = 0, l = locked[hash].length; i < l; i++){
        var t = locked[hash][i].t;
        if(t === this){
          //dont lock itself
          process.nextTick( job );
          return;
        }
        if(t.deps[this.id]){
          job(new Error('Deadlock')); //should be a very rare case
          return this;
        }
        this.deps[t.id] = true;
        for(j in t.deps){
          this.deps[j] = true;
        }
      }
    }else{
      locked[hash] = [];
      process.nextTick( job );
    }
    this.jobs[hash] = job;
    locked[hash].push(job);

    return this;
  };

  T._release = function(){
    var hash, i;
    for(hash in this.jobs){
      i = locked[hash].indexOf(this.jobs[hash]);
      if(i > -1)
        locked[hash].splice( i, 1 );
      if(locked[hash].length > 0){
        if(i === 0)
          process.nextTick( locked[hash][0] );
      }else{
        delete locked[hash];
      }
      delete this.jobs[hash];
    }
    this.deps = {};
    return this;
  };

  T.rollback = function(){
    this._release();
    this.batch = [];
    this.map = {};
    return this;
  };

  T.commit = function(cb){
    var self = this;
    db.batch(this.batch, function(){
      self._release();
      if(typeof cb === 'function')
        cb.apply(self, arguments);
    });
    return this;
  };

  db.transaction = db.transaction || function(){
    return new Transaction();
  };
  return db;
};
