'use strict';

/**
 * Module dependencies.
 */
var Address = require('../models/Address');
var Status = require('../models/Status');
var async = require('async');
var common = require('./common');
var util = require('util');

var Rpc = require('../../lib/Rpc');

var tDb = require('../../lib/TransactionDb').default();
var bdb = require('../../lib/BlockDb').default();

exports.send = function (req, res) {
  Rpc.sendRawTransaction(req.body.rawtx, function (err, txid) {
    if (err) {
      var message;
      if (err.code == -25) {
        message = util.format(
          'Generic error %s (code %s)',
          err.message, err.code);
      } else if (err.code == -26) {
        message = util.format(
          'Transaction rejected by network (code %s). Reason: %s',
          err.code, err.message);
      } else {
        message = util.format('%s (code %s)', err.message, err.code);
      }
      return res.status(400).send(message);
    }
    res.json({ 'txid': txid });
  });
};


/**
 * Find transaction by hash ...
 */
exports.transaction = function (req, res, next, txid) {

  tDb.fromIdWithInfo(txid, function (err, tx) {
    if (err || !tx)
      return common.handleErrors(err, res);
    else {
      req.transaction = tx.info;
      return next();
    }
  });
};


/**
 * Show transaction
 */
exports.show = function (req, res) {

  if (req.transaction) {
    res.jsonp(req.transaction);
  }
};


var getTransaction = function (txid, cb) {

  tDb.fromIdWithInfo(txid, function (err, tx) {
    if (err) console.log(err);

    if (!tx || !tx.info) {
      console.log('[transactions.js.48]:: TXid %s not found in RPC. CHECK THIS.', txid);
      return ({ txid: txid });
    }

    return cb(null, tx.info);
  });
};

exports.ranking = function (req, res, next) {
  var statusObject = new Status();
  statusObject.getInfo(function (err) {
    if (err || !statusObject) {
      console.log(err);
      return res.status(500).send('Get Status Error');
    }
    tDb.getRanking(function (ranking) {
      var total = parseFloat(statusObject.info.moneysupply);
      var sum00 = 0, sum01 = 0, sum02 = 0, sum03 = 0;
      var pc00 = 0, pc01 = 0, pc02 = 0, pc03 = 0;
      ranking.forEach(function (r) {
        r.percent = (parseFloat(r.balance) * 100 / total).toFixed(5);
        if (r.index < 25) {
          sum00 += parseFloat(r.balance);
        } else if (r.index < 50) {
          sum01 += parseFloat(r.balance);
        } else if (r.index < 75) {
          sum02 += parseFloat(r.balance);
        } else if (r.index < 100) {
          sum03 += parseFloat(r.balance);
        }
      });
      pc00 = sum00 * 100 / total;
      pc01 = sum01 * 100 / total;
      pc02 = sum02 * 100 / total;
      pc03 = sum03 * 100 / total;
      ranking.pop();
      res.jsonp({
        ranking: ranking,
        info: {
          sum00: sum00.toFixed(8),
          sum01: sum01.toFixed(8),
          sum02: sum02.toFixed(8),
          sum03: sum03.toFixed(8),
          sum: (sum00 + sum01 + sum02 + sum03).toFixed(8),
          pc00: pc00.toFixed(5),
          pc01: pc01.toFixed(5),
          pc02: pc02.toFixed(5),
          pc03: pc03.toFixed(5),
          pc: ((sum00 + sum01 + sum02 + sum03) * 100 / total).toFixed(5)
        }
      });
    });
  });
}

/**
 * List of transaction
 */
exports.list = function (req, res, next) {
  var bId = req.query.block;
  var addrStr = req.query.address;
  var page = req.query.pageNum;
  var pageLength = 10;
  var pagesTotal = 1;
  var txLength;
  var txs;

  if (bId) {
    bdb.fromHashWithInfo(bId, function (err, block) {
      if (err) {
        console.log(err);
        return res.status(500).send('Internal Server Error');
      }

      if (!block) {
        return res.status(404).send('Not found');
      }

      txLength = block.info.tx.length;

      if (page) {
        var spliceInit = page * pageLength;
        txs = block.info.tx.splice(spliceInit, pageLength);
        pagesTotal = Math.ceil(txLength / pageLength);
      }
      else {
        txs = block.info.tx;
      }

      async.mapSeries(txs, getTransaction, function (err, results) {
        if (err) {
          console.log(err);
          res.status(404).send('TX not found');
        }

        res.jsonp({
          pagesTotal: pagesTotal,
          txs: results
        });
      });
    });
  }
  else if (addrStr) {
    var a = new Address(addrStr);

    a.update(function (err) {
      if (err && !a.totalReceivedSat) {
        console.log(err);
        res.status(404).send('Invalid address');
        return next();
      }

      txLength = a.transactions.length;

      if (page) {
        var spliceInit = page * pageLength;
        txs = a.transactions.splice(spliceInit, pageLength);
        pagesTotal = Math.ceil(txLength / pageLength);
      }
      else {
        txs = a.transactions;
      }

      async.mapSeries(txs, getTransaction, function (err, results) {
        if (err) {
          console.log(err);
          res.status(404).send('TX not found');
        }

        res.jsonp({
          pagesTotal: pagesTotal,
          txs: results
        });
      });
    });
  }
  else {
    res.jsonp({
      txs: []
    });
  }
};

var getAddrs = function (req, res, next) {
  var as = [];
  try {
    var addrStrs = req.param('addrs');
    var s = addrStrs.split(',');
    if (s.length === 0) return as;
    for (var i = 0; i < s.length; i++) {
      var a = new Address(s[i]);
      as.push(a);
    }
  } catch (e) {
    common.handleErrors({
      message: 'Invalid address:' + e.message,
      code: 1
    }, res, next);
    return null;
  }
  return as;
};

exports.multitxs = function (req, res, next) {
  var iFrom = req.query.from;
  var iTo = req.query.to;

  var as = getAddrs(req, res, next);
  if (as) {
    var txs = [];
    var nTotalItems = 0;
    async.each(as, function (a, callback) {
      a.update(function (err) {
        var atxs;
        if (err && !a.totalReceivedSat) callback(err);
        nTotalItems += a.transactions.length;
        if (iFrom) {
          atxs = a.transactions.splice(iFrom, iTo);
        } else {
          atxs = a.transactions;
        }
        txs = txs.concat(atxs);
        callback();
      });
    }, function (err) { // finished callback
      if (err) return common.handleErrors(err, res);
      async.mapSeries(txs, getTransaction, function (err, results) {
        if (err) {
          console.log(err);
          res.status(404).send('TX not found');
        }
        results.sort(function (aaa, bbb) {
          var aa = parseInt(aaa.time);
          var bb = parseInt(bbb.time);
          if (aa < bb) return 1;
          if (aa > bb) return -1;
          return 0;
        });

        var ntxs = results.splice(iFrom, iTo);

        res.jsonp({
          totalItems: nTotalItems,
          from: iFrom,
          to: iTo,
          items: ntxs
        });
      });
    });
  }
}

var getTransactionForUtxo = function (utxo, cb) {
  var txid = utxo.txid;
  tDb.fromIdWithInfo(txid, function (err, tx) {
    if (err) console.log(err);

    if (!tx || !tx.info) {
      console.log('[transactions.js.48]:: TXid %s not found in RPC. CHECK THIS.', txid);
      return ({ txid: txid });
    }
    var nutxo = utxo;
    nutxo.confirmations = tx.info.confirmations;
    nutxo.satoshis = parseFloat(nutxo.amount) * 1e8;
    return cb(null, nutxo);
  });
};

exports.multiutxo = function (req, res, next) {
  var as = getAddrs(req, res, next);
  if (as) {
    var utxos = [];
    async.each(as, function (a, callback) {
      a.update(function (err) {
        if (err) callback(err);
        utxos = utxos.concat(a.unspent);
        callback();
      }, { onlyUnspent: 1, ignoreCache: req.param('noCache') });
    }, function (err) { // finished callback
      if (err) return common.handleErrors(err, res);
      async.mapSeries(utxos, getTransactionForUtxo, function (err, results) {
        if (err) {
          console.log(err);
          res.status(404).send('TX not found');
        }
        res.jsonp(results);
      });
    });
  }
};