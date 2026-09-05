/**
 * F1 — envelope encryption tests.
 *
 * These are the tests that matter most in the app: they cover the field the
 * whole security design is built around. Run with `npm test`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CryptoError,
  CURRENT_VERSION,
  decryptDocumentNumber,
  encryptDocumentNumber,
  importKey,
  looksLikeEnvelope,
} from './crypto.ts';

const KEY_A = 'K7dQvXnZ2mB4pR8sT1uW6yA0cE3gH5jL9oI2kN4qS7U=';
const KEY_B = 'Z9xW8vU7tS6rQ5pO4nM3lK2jI1hG0fE9dC8bA7zY6X0=';
const DOC_ID = '3f1a8c2e-5b7d-4e91-8a06-1c2d3e4f5a6b';
const OTHER_DOC_ID = '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a';

describe('importKey', () => {
  test('accepts a 32-byte base64 key', async () => {
    assert.ok(await importKey(KEY_A));
  });

  test('rejects an empty key with a message naming the secret', async () => {
    await assert.rejects(() => importKey(''), (e: Error) => {
      assert.ok(e instanceof CryptoError);
      assert.match(e.message, /DOCUMENT_ENCRYPTION_KEY/);
      return true;
    });
  });

  test('rejects a key of the wrong length', async () => {
    // A 16-byte key would silently give AES-128 in a naive implementation.
    const short = btoa(String.fromCharCode(...new Uint8Array(16)));
    await assert.rejects(() => importKey(short), /must decode to 32 bytes/);
  });

  test('rejects a key that is not base64', async () => {
    await assert.rejects(() => importKey('not base64!!'), CryptoError);
  });
});

describe('round trip', () => {
  test('decrypts back to the original number', async () => {
    const key = await importKey(KEY_A);
    const envelope = await encryptDocumentNumber('L898902C3', DOC_ID, key);
    assert.equal(await decryptDocumentNumber(envelope, DOC_ID, key), 'L898902C3');
  });

  test('trims surrounding whitespace before storing', async () => {
    const key = await importKey(KEY_A);
    const envelope = await encryptDocumentNumber('  PA1234567  ', DOC_ID, key);
    assert.equal(await decryptDocumentNumber(envelope, DOC_ID, key), 'PA1234567');
  });

  test('handles non-ASCII characters', async () => {
    const key = await importKey(KEY_A);
    const envelope = await encryptDocumentNumber('ÅÄÖ-123', DOC_ID, key);
    assert.equal(await decryptDocumentNumber(envelope, DOC_ID, key), 'ÅÄÖ-123');
  });

  test('refuses to encrypt an empty number', async () => {
    const key = await importKey(KEY_A);
    await assert.rejects(() => encryptDocumentNumber('   ', DOC_ID, key), CryptoError);
  });

  test('refuses to encrypt without a document id to bind to', async () => {
    const key = await importKey(KEY_A);
    await assert.rejects(() => encryptDocumentNumber('L898902C3', '', key), CryptoError);
  });
});

describe('envelope format', () => {
  test('is versioned, so a key rotation can be told apart on read', async () => {
    const key = await importKey(KEY_A);
    const envelope = await encryptDocumentNumber('L898902C3', DOC_ID, key);
    assert.ok(envelope.startsWith(`${CURRENT_VERSION}.`));
    assert.equal(envelope.split('.').length, 3);
    assert.ok(looksLikeEnvelope(envelope));
  });

  test('never contains the plaintext', async () => {
    const key = await importKey(KEY_A);
    const envelope = await encryptDocumentNumber('L898902C3', DOC_ID, key);
    assert.ok(!envelope.includes('L898902C3'));
  });

  test('a fresh IV per call means identical numbers store differently', async () => {
    // Otherwise equal ciphertexts would leak that two travelers share a number,
    // and make the column vulnerable to frequency analysis.
    const key = await importKey(KEY_A);
    const a = await encryptDocumentNumber('L898902C3', DOC_ID, key);
    const b = await encryptDocumentNumber('L898902C3', DOC_ID, key);
    assert.notEqual(a, b);
    assert.equal(await decryptDocumentNumber(a, DOC_ID, key), 'L898902C3');
    assert.equal(await decryptDocumentNumber(b, DOC_ID, key), 'L898902C3');
  });

  test('rejects a value that is not an envelope', async () => {
    const key = await importKey(KEY_A);
    await assert.rejects(() => decryptDocumentNumber('L898902C3', DOC_ID, key), CryptoError);
    await assert.rejects(() => decryptDocumentNumber('v1.only-two', DOC_ID, key), CryptoError);
  });

  test('rejects an unknown envelope version', async () => {
    const key = await importKey(KEY_A);
    const envelope = await encryptDocumentNumber('L898902C3', DOC_ID, key);
    const bumped = envelope.replace(/^v1\./, 'v9.');
    await assert.rejects(() => decryptDocumentNumber(bumped, DOC_ID, key), /Unsupported envelope/);
  });
});

describe('the properties the security design depends on', () => {
  test('the wrong key cannot decrypt', async () => {
    const keyA = await importKey(KEY_A);
    const keyB = await importKey(KEY_B);
    const envelope = await encryptDocumentNumber('L898902C3', DOC_ID, keyA);
    await assert.rejects(() => decryptDocumentNumber(envelope, DOC_ID, keyB), CryptoError);
  });

  test('ciphertext moved to another document row will not decrypt', async () => {
    // The point of binding the document id as additional authenticated data:
    // someone with write access to the table cannot copy one traveler's
    // encrypted number onto another document and read it back.
    const key = await importKey(KEY_A);
    const envelope = await encryptDocumentNumber('L898902C3', DOC_ID, key);
    await assert.rejects(
      () => decryptDocumentNumber(envelope, OTHER_DOC_ID, key),
      CryptoError
    );
  });

  test('a tampered ciphertext is rejected, not silently mangled', async () => {
    // GCM authenticates; a stream cipher without a tag would decrypt this to
    // corrupted plaintext and hand it back as though it were real.
    const key = await importKey(KEY_A);
    const envelope = await encryptDocumentNumber('L898902C3', DOC_ID, key);
    const [v, iv, ct] = envelope.split('.');
    const flipped = ct[0] === 'A' ? 'B' + ct.slice(1) : 'A' + ct.slice(1);
    await assert.rejects(
      () => decryptDocumentNumber(`${v}.${iv}.${flipped}`, DOC_ID, key),
      CryptoError
    );
  });

  test('a tampered IV is rejected', async () => {
    const key = await importKey(KEY_A);
    const envelope = await encryptDocumentNumber('L898902C3', DOC_ID, key);
    const [v, iv, ct] = envelope.split('.');
    const flipped = iv[0] === 'A' ? 'B' + iv.slice(1) : 'A' + iv.slice(1);
    await assert.rejects(
      () => decryptDocumentNumber(`${v}.${flipped}.${ct}`, DOC_ID, key),
      CryptoError
    );
  });

  test('failure messages do not say which check failed', async () => {
    // Distinguishing "wrong key" from "tampered" from "wrong document" would
    // tell an attacker which of those they had achieved.
    const keyA = await importKey(KEY_A);
    const keyB = await importKey(KEY_B);
    const envelope = await encryptDocumentNumber('L898902C3', DOC_ID, keyA);

    const wrongKey = await decryptDocumentNumber(envelope, DOC_ID, keyB).catch((e) => e.message);
    const wrongDoc = await decryptDocumentNumber(envelope, OTHER_DOC_ID, keyA).catch(
      (e) => e.message
    );
    assert.equal(wrongKey, wrongDoc);
  });
});
