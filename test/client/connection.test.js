'use strict';

const mm = require('mm');
const assert = require('assert');
const urlparse = require('url').parse;
const sleep = require('mz-modules/sleep');
const awaitEvent = require('await-event');
const RpcServer = require('../../').server.RpcServer;
const RpcRequest = require('../../').client.RpcRequest;
const RpcConnection = require('../..').client.RpcConnection;
const DynamicConfig = require('../../lib/client/dynamic_config');
const HealthCounter = require('../../lib/client/metric/health_counter');

const logger = console;
const port = 13333;

describe('test/client/connection.test.js', () => {
  let server;
  before(async function() {
    server = new RpcServer({
      appName: 'test',
      logger,
      port,
    });
    server.addService({
      interfaceName: 'com.alipay.test.TestService',
      apiMeta: {
        methods: [{
          name: 'plus',
          parameterTypes: [
            'java.lang.Integer',
            'java.lang.Integer',
          ],
          returnType: 'java.lang.Integer',
        }],
      },
    }, {
      // a + b
      async plus(a, b) {
        await sleep(100);
        return a + b;
      },
    });
    await server.start();
  });
  after(async function() {
    await server.close();
  });
  afterEach(mm.restore);

  it('connection ready 时确保 socket 连上', async function() {
    const address = urlparse('bolt://127.0.0.1:' + port, true);
    const connection = new RpcConnection({ address, logger });
    await connection.ready();
    assert(connection.isOk);
    assert(connection.isConnected);
    assert(!connection.isClosed);
    assert(connection.lastInvokeTime === -1);
    assert(connection._lastActiveTime === -1);
    assert(connection._socket && connection._socket.remoteAddress);
    assert(connection._encoder && connection._decoder);

    await Promise.all([
      connection.close(),
      awaitEvent(connection._encoder, 'close'),
      awaitEvent(connection._decoder, 'close'),
    ]);
  });

  it('连不上时 connection ready failed', async function() {
    const address = urlparse('bolt://2.2.2.2:12200', true);
    const connection = new RpcConnection({ address, logger });
    assert(!connection.isClosed);
    try {
      await connection.ready();
      assert(false);
    } catch (err) {
      assert(err.message === 'socket#bolt://2.2.2.2:12200 connect timeout(3000ms)' ||
        err.message === 'connect ECONNREFUSED 2.2.2.2:12200');
    }
    await connection.await('close');
  });

  it('invoke(req, options)', async function() {
    const address = urlparse('bolt://127.0.0.1:' + port, true);
    const connection = new RpcConnection({ address, logger });
    await connection.ready();

    const args = [{
      $class: 'java.lang.Integer',
      $: 1,
    }, {
      $class: 'java.lang.Integer',
      $: 2,
    }];
    const req = new RpcRequest({
      serverSignature: 'com.alipay.test.TestService:1.0',
      methodName: 'plus',
      args,
      requestProps: {},
      timeout: 3000,
    });
    const res = await connection.invoke(req);
    assert.deepEqual(res, { error: null, appResponse: 3, responseProps: null });
    await connection.close();
  });

  it('should wait pedding requests before close the client', async function() {
    const address = urlparse('bolt://127.0.0.1:' + port + '?serialization=hessian2', true);
    let connection = new RpcConnection({ address, logger });

    const args = [{
      $class: 'java.lang.Integer',
      $: 1,
    }, {
      $class: 'java.lang.Integer',
      $: 2,
    }];
    const req = new RpcRequest({
      serverSignature: 'com.alipay.test.TestService:1.0',
      methodName: 'plus',
      args,
      requestProps: {},
      timeout: 3000,
    });

    const res = await connection.invoke(req);
    assert.deepEqual(res, { error: null, appResponse: 3, responseProps: null });

    const tasks = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(connection.invoke(req));
    }

    connection.close();

    const result = await Promise.all(tasks);
    assert(result.every(r => r.appResponse === 3));


    connection = new RpcConnection({ address, logger });
    const promise = connection.invoke(req);
    connection.forceClose();

    try {
      await promise;
      assert(false);
    } catch (err) {
      err.message.includes('The socket was closed. (address: address => ');
    }
  });

  it('should not emit error after close', async function() {
    const address = urlparse(`bolt://127.0.0.1:${port}`, true);
    const connection = new RpcConnection({ address, logger });
    await connection.ready();

    let err;
    connection.once('error', e => {
      err = e;
    });

    connection._socket.destroy();
    connection._isClosing = true;
    connection._encoder.writeHeartbeat();

    await sleep(3000);

    assert(!err);
    await connection.close();
  });

  it('心跳', async function() {
    const address = urlparse(`bolt://127.0.0.1:${port}`, true);
    const connection = new RpcConnection({ address, logger });
    await connection.ready();

    assert(connection.lastInvokeTime === -1);
    assert(connection._lastActiveTime === -1);

    connection.heartbeat();

    await awaitEvent(connection._decoder, 'heartbeat_ack');
    await connection.close();
  });

  it('should warn if received unrecord response', async () => {
    const address = urlparse(`bolt://127.0.0.1:${port}`, true);
    const connection = new RpcConnection({ address, logger });
    await connection.ready();

    let called = false;
    mm(connection.logger, 'warn', msg => {
      if (msg === '[RpcConnection] can not find invoke request for response: %j, maybe it\'s timeout.') {
        called = true;
      }
    });

    connection._handleResponse({
      packetId: 1000,
    });
    assert(called);

    await connection.close();
  });

  it('should handle socket error properly', async () => {
    let address = urlparse('bolt://127.0.0.1:8080', true);
    let connection = new RpcConnection({ address, logger });
    try {
      await connection.ready();
      assert(false);
    } catch (err) {
      assert(err.code === 'ECONNREFUSED');
    }

    address = urlparse(`bolt://127.0.0.1:${port}`, true);
    connection = new RpcConnection({ address, logger });
    await connection.ready();
    assert(connection.isConnected);

    let called = false;
    connection.once('error', err => {
      console.log(err);
      called = true;
    });

    mm(connection, '_isClosing', true);
    connection._handleSocketError(new Error('mock error'));
    assert(called === false);
    mm.restore();
    mm(connection, '_closed', true);
    connection._handleSocketError(new Error('mock error'));
    assert(called === false);
    mm.restore();

    const err = new Error('ECONNRESET');
    err.code = 'ECONNRESET';
    connection._handleSocketError(err);
    assert(called === false);

    connection._handleSocketError(new Error('mock error'));
    assert(called);
    await connection.close();
  });

  describe('熔断', () => {
    const address = urlparse('bolt://127.0.01:' + port, true);
    let connection;
    beforeEach(() => {
      mm(DynamicConfig.instance.metric, 'numBuckets', 10);
      mm(DynamicConfig.instance.metric, 'bucketSizeInMs', 100);
      mm(DynamicConfig.instance.circuitBreaker, 'requestVolumeThreshold', 5);
      mm(DynamicConfig.instance.circuitBreaker, 'sleepWindowInMilliseconds', 500);
    });
    before(async function() {
      mm(DynamicConfig.instance.metric, 'numBuckets', 10);
      mm(DynamicConfig.instance.metric, 'bucketSizeInMs', 100);
      mm(DynamicConfig.instance.circuitBreaker, 'requestVolumeThreshold', 5);
      mm(DynamicConfig.instance.circuitBreaker, 'sleepWindowInMilliseconds', 500);
      connection = new RpcConnection({ address, logger });
      await connection.ready();
    });
    after(async function() {
      await connection.close();
    });


    it('调用量没有达到阀值不开启熔断', async function() {
      const args = [{
        $class: 'java.lang.Integer',
        $: 1,
      }, {
        $class: 'java.lang.Integer',
        $: 2,
      }];
      const req = new RpcRequest({
        serverSignature: 'com.alipay.test.TestService:1.0',
        methodName: 'plus',
        args,
        requestProps: {},
        timeout: 1,
      });
      let count = 4;
      while (count--) {
        const res = await connection.invoke(req);
        assert(res.error && req.meta.resultCode === '03');
      }
      await HealthCounter.getInstance(connection.key).await('next');

      req.timeout = 3000;
      const res = await connection.invoke(req);
      assert.deepEqual(res, { error: null, appResponse: 3, responseProps: null });
    });

    it('开启熔断，以及熔断恢复', async function() {
      const args = [{
        $class: 'java.lang.Integer',
        $: 1,
      }, {
        $class: 'java.lang.Integer',
        $: 2,
      }];
      const req = new RpcRequest({
        serverSignature: 'com.alipay.test.TestService:1.0',
        methodName: 'plus',
        args,
        requestProps: {},
        timeout: 1,
      });
      connection.resetCounter();

      let count = 10;
      while (count--) {
        const res = await connection.invoke(req);
        assert(res.error);
      }
      await HealthCounter.getInstance(connection.key).await('next');

      assert(connection.latestHealthCount.totalCount >= 6);
      assert(connection.latestHealthCount.errorCount >= 6);
      assert(connection.latestHealthCount.errorRate > 80);

      req.timeout = 3000;
      let res = await connection.invoke(req);
      assert(res.error && req.meta.resultCode === '02');
      assert(res.error.message.includes('this request is block by circuit breaker, HealthCounts'));

      await sleep(connection._circuitBreaker.config.sleepWindowInMilliseconds);

      res = await connection.invoke(req);
      assert.deepEqual(res, { error: null, appResponse: 3, responseProps: null });
    });
  });
});
