
module.exports = Filewalker;

/* ----------------------------------------------------------- */

var path = require('path'),
    fs = require('fs'),
    util = require('util'),
    EventEmitter = require('events').EventEmitter;

var lstat = process.platform === 'win32' ? 'stat' : 'lstat';

/* ----------------------------------------------------------- */

function Filewalker(root, options) {
  if(!(this instanceof Filewalker)) return new Filewalker(root, options);
  
  var self = this;
  
  this.maxPending = -1;
  this.maxAttempts = 3;
  this.attemptTimeout = 5000;
  this.matchRegExp = null;
  
  options = options || {};
  Object.keys(options).forEach(function(k) {
    if(self.hasOwnProperty(k)) {
      self[k] = options[k];
    }
  });
  
  this.root = path.resolve(root||'.');
}
util.inherits(Filewalker, EventEmitter);

Filewalker.prototype._path = function(p) {
  if(path.relative) {
    return path.relative(this.root, p).split('\\').join('/');
  } else {
    return p.substr(this.root.length).split('\\').join('/');
  }
};

Filewalker.prototype._queueIsEmpty = function() {
  if(this.queue.length) {
    return false;
  } else {
    return true;
  }
};

Filewalker.prototype._enqueue = function(item, timeout) {
  if(timeout) {
    this.queue.push(['_timeout', timeout, item]);
  } else {
    this.queue.push(item);
  }
};

Filewalker.prototype._dequeue = function() {
  if(this.paused) {
    return;
  }
  
  var item = this.queue.shift();
  if(item) {
    this[item[0]].apply(this, item.slice(1));
  }
};

Filewalker.prototype._timeout = function(timeout, item) {
  if(!this._start()) {
    this._enqueue(['_timeout', timeout, item]);
    return;
  }
  
  var self = this;
  setTimeout(function() {
    self._enqueue(item);
    self._done();
  }, timeout);
};

Filewalker.prototype._start = function() {
  if(this.paused) {
    return false;
  }
  if(this.maxPending <= 0 || this.pending < this.maxPending) {
    this.pending += 1;
    return true;
  }
  return false;
};

Filewalker.prototype._done = function() {
  this.pending -= 1;
  
  if(this._queueIsEmpty() === false && (this.maxPending <= 0 || this.pending < this.maxPending)) {
    this._dequeue();
  }
  
  if(this.pending === 0) {
    if(this.paused) {
      this.emit('pause');
    } else {
      this.emit('done');
    }
  }
};

Filewalker.prototype._emitDir = function(p, s, fullPath, prevErr, attempts) {
  var self = this;
  
  if(!this._start()) {
    this._enqueue(['_emitDir', p, s, fullPath, prevErr, attempts]);
    return;
  }
  
  attempts = attempts || 0;
  if(this.maxAttempts > -1 && attempts >= this.maxAttempts) {
    this.errors += 1;
    this.emit('error', prevErr);
    this._done();
    return;
  }
  
  if(!attempts) {
    this.dirs += 1;
    if(this.dirs) { // skip first directroy
      this.emit('dir', p, s, fullPath);
    }
  }
  
  fs.readdir(fullPath, function(err, files) {
    if(err) {
      self.attempts += 1;
      self._enqueue(['_emitDir', p, s, fullPath, err, attempts+1], self.attemptTimeout);
    } else {
      files.forEach(function(file) {
        self._stat(path.join(fullPath, file));
      });
    }
    self._done();
  });
};

Filewalker.prototype._emitFile = function(p, s, fullPath) {
  var self = this;
  
  if(!this._start()) {
    this._enqueue(['_emitFile', p, s, fullPath]);
    return;
  }
  
  this.files += 1;
  this.bytes += s.size;
  this.emit('file', p, s, fullPath);
  
  if(this.listeners('stream').length !== 0) {
    this._emitStream(p, s, fullPath);
  }
  
  process.nextTick(function() {
    self._done();
  });
};

Filewalker.prototype._emitStream = function(p, s, fullPath, lastError, attempts) {
  var self = this;
  
  if(!this._start()) {
    this._enqueue(['_emitStream', p, s, fullPath, lastError, attempts]);
    return;
  }
  
  attempts = attempts || 0;
  if(this.maxAttempts > -1 && attempts >= this.maxAttempts) {
    process.stdout.write('\n');
    console.log('Giving up after %s attempts', attempts, p);
    this.streamErrors += 1;
    this.emit('error', lastError);
    this._done();
    return;
  }
  
  this.open += 1;
  
  var rs = fs.ReadStream(fullPath);
  
  // retry on any error
  rs.on('error', function(err) {
    // handle "too many open files" error
    if(err.code == 'OK' && err.errno === 0) {
      self._enqueue(['_emitStream', p, s, fullPath, err, attempts]);
      
      if(self.open-1>self.detectedMaxOpen) {
        self.detectedMaxOpen = self.open-1;
      }
    } else {
      self._enqueue(['_emitStream', p, s, fullPath, err, attempts+1], self.attemptTimeout);
    }
    
    self.attempts += 1;
    self.open -= 1;
    self._done();
  });

  rs.on('close', function() {
    self.streamed += 1;
    self.open -= 1;
    self._done();
  });
  
  this.emit('stream', rs, p, s, fullPath);
  
};

Filewalker.prototype._stat = function(p, prevErr, attempts) {
  var self = this;
  
  if(!this._start()) {
    this._enqueue(['_stat', p, prevErr, attempts]);
    return;
  }
  
  attempts = attempts || 0;
  if(this.maxAttempts > -1 && attempts >= this.maxAttempts) {
    this.errors += 1;
    this.emit('error', prevErr);
    this._done();
    return;
  }
  
  if(!attempts) {
    this.total += 1;
  }
  
  fs[lstat](p, function(err, s) {
    if(err) {
      self.attempts += 1;
      self._enqueue(['_stat', p, err, attempts+1], self.attemptTimeout);
    } else {
      if(s.isDirectory()) {
        self._emitDir(self._path(p), s, p);
      } else {
        if(!self.matchRegExp || self.matchRegExp.test(p)) {
          self._emitFile(self._path(p), s, p);
        }
      }
    }
    self._done();
  });
};

Filewalker.prototype.pause = function() {
  this.paused = true;
};

Filewalker.prototype.resume = function() {
  if(this.paused) {
    this.paused = false;
    if(this._queueIsEmpty()) {
      this.pending = 1;
      this._done();
    } else {
      this._dequeue();
      this.emit('resume');
    }
  }
};

Filewalker.prototype.walk = function() {
  this.paused = false;
  this.pending = 0;
  
  this.dirs = -1;
  this.files = 0;
  this.total = -1;
  this.bytes = 0;
  
  this.errors = 0;
  this.attempts = 0;
  
  this.streamed = 0;
  this.streamErrors = 0;
  this.open = 0;
  this.detectedMaxOpen = -1;
  
  this.queue = [];
  
  this._stat(this.root);
};
