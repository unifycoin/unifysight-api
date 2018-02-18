'use strict';

var imports = require('soop').imports();

var config = imports.config || require('../config/config');
var bitcore = require('unifycore');
var networks = bitcore.networks;
var async = require('async');

var logger = require('./logger').logger;
var d = logger.log;
var info = logger.info;



var syncId = 0;

function Sync(opts) {
  this.id = syncId++;
  this.opts = opts || {};
  this.bDb = require('./BlockDb').default();
  this.txDb = require('./TransactionDb').default();
  this.network = config.network === 'testnet' ? networks.testnet : networks.livenet;
  this.cachedLastHash = null;
}

Sync.prototype.close = function (cb) {
  var self = this;
  self.txDb.close(function () {
    self.bDb.close(cb);
  });
};


Sync.prototype.destroy = function (next) {
  var self = this;
  async.series([

    function (b) {
      self.bDb.drop(b);
    },
    function (b) {
      self.txDb.drop(b);
    },
  ], next);
};

/*
  * Arrives a NEW block, which is the new TIP
  *
  * Case 0) Simple case
  *    A-B-C-D-E(TIP)-NEW
  *
  * Case 1)
  *    A-B-C-D-E(TIP)
  *        \
  *         NEW
  *
  *  1) Declare D-E orphans (and possible invalidate TXs on them)
  *
  * Case 2)
  *    A-B-C-D-E(TIP)
  *        \
  *         F-G-NEW
  *  1) Set F-G as connected (mark TXs as valid)
  *  2) Set new heights  in F-G-NEW 
  *  3) Declare D-E orphans (and possible invalidate TXs on them)
  *
  *
  * Case 3)
  *
  *    A-B-C-D-E(TIP) ...  NEW
  *
  *    NEW is ignored (if allowReorgs is false)
  *
  *
  */

Sync.prototype._addTxItem = function (addrInfo, txItem) {
  var add = 0, addSpend = 0;
  var v = txItem.value_sat;
  var seen = addrInfo.seen;

  // Founding tx
  if (!seen[txItem.txid]) {
    seen[txItem.txid] = 1;
    add = 1;
  }

  // Spent tx
  if (txItem.spentTxId && !seen[txItem.spentTxId]) {
    seen[txItem.spentTxId] = 1;
    addSpend = 1;
  }
  if (txItem.isConfirmed) {
    addrInfo.txApperances += add;
    addrInfo.totalReceivedSat += v;
    if (!txItem.spentTxId) {
      //unspent
      addrInfo.balanceSat += v;
    } else if (!txItem.spentIsConfirmed) {
      // unspent
      addrInfo.balanceSat += v;
      addrInfo.unconfirmedBalanceSat -= v;
      addrInfo.unconfirmedTxApperances += addSpend;
    }
    else {
      // spent
      addrInfo.totalSentSat += v;
      addrInfo.txApperances += addSpend;
    }
  }
  else {
    addrInfo.unconfirmedBalanceSat += v;
    addrInfo.unconfirmedTxApperances += add;
  }
}

Sync.prototype._getAddressBalanceEx = function (addr, cb) {
  var self = this;
  var opts = {};
  var addrInfo = {
    'address': addr,
    'balance': 0,
    'balanceSat': 0,
    'totalReceivedSat': 0,
    'totalSentSat': 0,
    'unconfirmedBalanceSat': 0,
    'unconfirmedTxApperances': 0,
    'txApperances': 0,
    'transactions': [],
    'seen': {}
  };
  opts.ignoreCache = config.ignoreCache;
  self.txDb.fromAddr(addr, opts, function (err, txOut) {
    if (err) return cb(err);

    self.bDb.fillConfirmations(txOut, function (err) {
      if (err) return cb(err);
      self.txDb.cacheConfirmations(txOut, function (err) {
        if (err) return cb(err);
        txOut.forEach(function (txItem) {
          self._addTxItem(addrInfo, txItem);
        });
        addrInfo.balance = parseFloat(addrInfo.balanceSat) / parseFloat(bitcore.util.COIN);
        addrInfo.transactions = [];
        addrInfo.seen = {};
        return cb(false, addrInfo);
      });
    });
  });
}

Sync.prototype._getAddressBalance = function (addr, cb) {
  var self = this;
  var opts = {};
  var addrInfo = {
    'address': addr,
    'balance': 0,
    'balanceSat': 1000,
    'totalReceivedSat': 0,
    'totalSentSat': 0,
    'unconfirmedBalanceSat': 0,
    'unconfirmedTxApperances': 0,
    'txApperances': 0,
    'transactions': [],
    'seen': {}
  };
  return cb(false, addrInfo);
}

Sync.prototype._processAddresses = function (addrs, cb) {
  var self = this;
  addrs.forEach(function (addr) {
    self._getAddressBalance(addr, cb);
  });
}

Sync.prototype.processAddressInfo = function (addrInfo, cb) {
  var self = this;
  self.txDb.updateRanking(addrInfo, function (err) {
    if (err) return console.log('Ooops!', err);
  });
}

Sync.prototype.getBalances = function (addrList, cb) {
  var self = this;
  var tasks = [];
  addrList.forEach(function (addr) {
    tasks.push(function (c) {
      self._getAddressBalance(addr, function (err, addrInfo) {
        if (err) return c(err);
        return c(err, addrInfo);
      });
    });
  });
  async.series(tasks, function (err, results) {
    if (err) return console.log(err);
    return cb(err, results);
  });
}

Sync.prototype.addressIndex = function (b, cb) {
  var self = this;
  self.bDb.fromHashWithInfo(b.hash, function (err, block) {
    if (err) {
      return cb(err);
    }
    if (block.info) {
      var txList = block.info.tx;
      txList.forEach(function (txid) {
        self.txDb.fromIdWithInfo(txid, function (err, tx) {
          if (err) return console.log(err);
          if (!tx || !tx.info) {
            return console.log(err);
          }
          var addrList = [];
          var vin = tx.info.vin;
          var vout = tx.info.vout;

          for (var i = 0; i < vin.length; i++) {
            var vinItem = vin[i];
            if (!vinItem.addr) continue;
            if (addrList.indexOf(vinItem.addr) < 0) {
              addrList.push(vinItem.addr);
            }
          }

          vout.forEach(function (voutItem) {
            var addresses = voutItem.scriptPubKey.addresses;
            if (addresses) {
              // console.log(addresses);
              addresses.forEach(function (address) {
                if (addrList.indexOf(address) < 0) {
                  addrList.push(address);
                }
              });
            }
          });
          // start
          if (addrList.length > 0) {
            self.getBalances(addrList, function (err, balances) {
              if (err) return cb(err);
              // console.log("************************************");
              // console.log(balances);
              self.txDb.updateRankingEx(balances, function (err, ranking) {
                if (err) return cb(err);
                // console.log(">>>HOOK: updateRankingEx OK!!!");
              });
            });
          }
        });
      });
    }
  });
}

Sync.prototype.addressIndexEx = function (b, cb) {
  var self = this;
  self.bDb.fromHashWithInfo(b.hash, function (err, block) {
    if (err) {
      return cb(err);
    }
    if (block.info) {
      var tasks = [];
      block.info.tx.forEach(function (txid) {
        tasks.push(function (c) {
          self.txDb.fromIdWithInfo(txid, function (err, t) {
            if (err) {
              return c(err);
            }
            return c(err, t);
          });
        });
      });
      async.series(tasks, function (err, txList) {
        if (err) return cb(err);
        var addrList = [];
        for (var i = 0; i < txList.length; i++) {
          var tx = txList[i];
          if (!tx || !tx.info) continue;
          var vin = tx.info.vin;
          var vout = tx.info.vout;
          for (var j = 0; j < vin.length; j++) {
            var vinItem = vin[j];
            if (!vinItem.addr) continue;
            if (addrList.indexOf(vinItem.addr) < 0) {
              addrList.push(vinItem.addr);
            }
          }
          vout.forEach(function (voutItem) {
            var addresses = voutItem.scriptPubKey.addresses;
            if (addresses) {
              addresses.forEach(function (address) {
                if (addrList.indexOf(address) < 0) {
                  addrList.push(address);
                }
              });
            }
          });
        }
        // console.log(addrList);
        if (addrList.length > 0) {
          self.getBalances(addrList, function (err, balances) {
            if (err) return cb(err);
            self.txDb.updateRankingEx(balances, function (err, ranking) {
              if (err) return cb(err);
              // console.log(">>>HOOK: updateRankingEx OK!!!");
              // console.log(">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>");
              return cb();
            });
          });
        } else {
          return cb();
        }
      });
    } else {
      return cb();
    }
  });
}

Sync.prototype.storeTipBlock = function (b, allowReorgs, cb) {
  if (typeof allowReorgs === 'function') {
    cb = allowReorgs;
    allowReorgs = true;
  }
  if (!b) return cb();
  var self = this;

  if (self.storingBlock) {
    logger.debug('Storing a block already. Delaying storeTipBlock with:' +
      b.hash);
    return setTimeout(function () {
      logger.debug('Retrying storeTipBlock with: ' + b.hash);
      self.storeTipBlock(b, allowReorgs, cb);
    }, 1000);
  }

  self.storingBlock = 1;
  var oldTip, oldNext, oldHeight, needReorg = false, height = -1;
  var newPrev = b.previousblockhash;
  // console.log(">>>HOOK: storeTipBlock");
  async.series([
    function (c) {
      if (!allowReorgs || newPrev === self.cachedLastHash) return c();
      self.bDb.has(newPrev, function (err, val) {
        // Genesis? no problem
        if (!val && newPrev.match(/^0+$/)) return c();
        return c(err ||
          (!val ? new Error('NEED_SYNC Ignoring block with non existing prev:' + b.hash) : null));
      });
    },
    function (c) {
      if (!allowReorgs) return c();
      self.bDb.getTip(function (err, hash, h) {
        oldTip = hash;
        oldHeight = hash ? (h || 0) : -1
        if (oldTip && newPrev !== oldTip) {
          needReorg = true;
          logger.debug('REORG Triggered, tip mismatch');
        }
        return c();
      });
    },

    function (c) {
      if (!needReorg) return c();
      self.bDb.getNext(newPrev, function (err, val) {
        if (err) return c(err);
        oldNext = val;
        return c();
      });
    },
    function (c) {
      if (!allowReorgs) return c();
      if (needReorg) {
        info('NEW TIP: %s NEED REORG (old tip: %s #%d)', b.hash, oldTip, oldHeight);
        self.processReorg(oldTip, oldNext, newPrev, oldHeight, function (err, h) {
          if (err) throw err;

          height = h;
          return c();
        });
      }
      else {
        height = oldHeight + 1;
        return c();
      }
    },
    function (c) {
      self.cachedLastHash = b.hash;   // just for speed up.
      self.bDb.add(b, height, c);
    },
    function (c) {
      if (!allowReorgs) return c();
      self.bDb.setTip(b.hash, height, function (err) {
        return c(err);
      });
    },
    function (c) {
      self.bDb.setNext(newPrev, b.hash, function (err) {
        return c(err);
      });
    }

  ],
    function (err) {
      if (err && err.toString().match(/WARN/)) {
        err = null;
      }
      self.addressIndexEx(b, function (err) {
        if (err) console.log(err);
        self.storingBlock = 0;
      });
      return cb(err, height);
    });
};

Sync.prototype.processReorg = function (oldTip, oldNext, newPrev, oldHeight, cb) {
  var self = this;

  var orphanizeFrom, newHeight;

  async.series([

    function (c) {
      self.bDb.getHeight(newPrev, function (err, height) {
        if (!height) {
          // Case 3 + allowReorgs = true
          return c(new Error('Could not found block:' + newPrev));
        }
        if (height < 0) return c();

        newHeight = height + 1;
        info('Reorg Case 1) OldNext: %s NewHeight: %d', oldNext, newHeight);
        orphanizeFrom = oldNext;
        return c(err);
      });
    },
    function (c) {
      if (orphanizeFrom) return c();

      info('Reorg Case 2)');
      self.setBranchConnectedBackwards(newPrev, function (err, yHash, newYHashNext, height) {
        if (err) return c(err);
        newHeight = height;
        self.bDb.getNext(yHash, function (err, yHashNext) {
          // Connect the new branch, and orphanize the old one.
          orphanizeFrom = yHashNext;
          self.bDb.setNext(yHash, newYHashNext, function (err) {
            return c(err);
          });
        });
      });
    },
    function (c) {
      if (!orphanizeFrom) return c();
      self._setBranchOrphan(orphanizeFrom, function (err) {
        return c(err);
      });
    },
  ],
    function (err) {
      return cb(err, newHeight);
    });
};

Sync.prototype._setBranchOrphan = function (fromHash, cb) {
  var self = this,
    hashInterator = fromHash;

  async.whilst(
    function () {
      return hashInterator;
    },
    function (c) {
      self.bDb.setBlockNotMain(hashInterator, function (err) {
        if (err) return cb(err);
        self.bDb.getNext(hashInterator, function (err, val) {
          hashInterator = val;
          return c(err);
        });
      });
    }, cb);
};

Sync.prototype.setBranchConnectedBackwards = function (fromHash, cb) {
  //console.log('[Sync.js.219:setBranchConnectedBackwards:]',fromHash); //TODO
  var self = this,
    hashInterator = fromHash,
    lastHash = fromHash,
    yHeight,
    branch = [];

  async.doWhilst(
    function (c) {
      branch.unshift(hashInterator);

      self.bDb.getPrev(hashInterator, function (err, val) {
        if (err) return c(err);
        lastHash = hashInterator;
        hashInterator = val;
        self.bDb.getHeight(hashInterator, function (err, height) {
          yHeight = height;
          return c();
        });
      });
    },
    function () {
      return hashInterator && yHeight <= 0;
    },
    function () {
      info('\tFound yBlock: %s #%d', hashInterator, yHeight);
      var heightIter = yHeight + 1;
      var hashIter;
      async.whilst(
        function () {
          hashIter = branch.shift();
          return hashIter;
        },
        function (c) {
          self.bDb.setBlockMain(hashIter, heightIter++, c);
        },
        function (err) {
          return cb(err, hashInterator, lastHash, heightIter);
        });
    });
};


//Store unconfirmed TXs
Sync.prototype.storeTx = function (tx, cb) {
  this.txDb.add(tx, cb);
};


module.exports = require('soop')(Sync);
