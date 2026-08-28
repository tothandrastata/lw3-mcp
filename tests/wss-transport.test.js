import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WssTransport, AuthRequiredError, WSS_PATH, WSS_USER } from '../src/transports/wss.js';

test('targets the /lw3 endpoint as the admin user', () => {
  assert.equal(WSS_PATH, '/lw3');
  assert.equal(WSS_USER, 'admin');
});

test('builds a wss URL from the host', () => {
  const t = new WssTransport('192.168.2.104', undefined);
  assert.equal(t.url, 'wss://192.168.2.104/lw3');
});

test('sends no Authorization header when no password was given', () => {
  const t = new WssTransport('device.local', undefined);
  assert.deepEqual(t.headers(), {});
});

test('sends Basic auth for the admin user when a password was given', () => {
  const t = new WssTransport('device.local', 'secret');
  const expected = 'Basic ' + Buffer.from('admin:secret').toString('base64');
  assert.equal(t.headers().Authorization, expected);
});

test('AuthRequiredError distinguishes "no password yet" from "password rejected"', () => {
  const first = new AuthRequiredError(false);
  const retry = new AuthRequiredError(true);

  assert.equal(first.name, 'AuthRequiredError');
  assert.equal(first.passwordWasSupplied, false);
  assert.match(first.message, /admin/, 'names the account the user must supply a password for');

  assert.equal(retry.passwordWasSupplied, true);
  assert.match(retry.message, /rejected/i, 'a rejected password must read differently, or the model retries forever');
  assert.notEqual(first.message, retry.message);
});

test('no error message leaks the password', () => {
  const t = new WssTransport('device.local', 'hunter2');
  const messages = [
    new AuthRequiredError(true).message,
    new AuthRequiredError(false).message,
    t.url,
  ];
  for (const m of messages) assert.doesNotMatch(m, /hunter2/);
});
