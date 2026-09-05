/**
 * F1 — tests for the device-independent parts of the scan pipeline.
 *
 * The native capture and OCR themselves need a dev build and a real document,
 * but two things here are pure logic and worth pinning down: turning ML Kit's
 * result shape into lines, and recognising a missing native module so the app
 * offers manual entry rather than showing a stack trace.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isMissingNativeModule, ocrResultToLines } from './scan.ts';

describe('ocrResultToLines', () => {
  test('prefers the block/line tree, which preserves layout', () => {
    const result = {
      text: 'ignored\nflat\ntext',
      blocks: [
        { lines: [{ text: 'PASSPORT' }, { text: 'AUSTRALIA' }] },
        { lines: [{ text: 'P<AUSERIKSSON<<ANNA' }] },
      ],
    };
    assert.deepEqual(ocrResultToLines(result), ['PASSPORT', 'AUSTRALIA', 'P<AUSERIKSSON<<ANNA']);
  });

  test('falls back to a block without a lines array', () => {
    const result = { blocks: [{ text: 'LINE ONE\nLINE TWO' }] };
    assert.deepEqual(ocrResultToLines(result), ['LINE ONE', 'LINE TWO']);
  });

  test('falls back to the flat text when there are no blocks', () => {
    assert.deepEqual(ocrResultToLines({ text: 'ONE\nTWO' }), ['ONE', 'TWO']);
  });

  test('returns nothing for an empty or malformed result', () => {
    assert.deepEqual(ocrResultToLines({}), []);
    assert.deepEqual(ocrResultToLines(null), []);
    assert.deepEqual(ocrResultToLines({ blocks: [] }), []);
  });
});

describe('isMissingNativeModule', () => {
  test('recognises the shapes React Native uses to report a missing module', () => {
    const messages = [
      "Cannot find native module 'DocumentScanner'",
      "TurboModuleRegistry.getEnforcing(...): 'RNMLKitTextRecognition' could not be found",
      'requireNativeModule failed',
      "null is not an object (evaluating 'NativeModules.DocumentScanner.scanDocument')",
      'Native module DocumentScanner is null',
    ];
    for (const m of messages) {
      assert.ok(isMissingNativeModule(m), `should have matched: ${m}`);
    }
  });

  test('does not swallow a genuine scan failure', () => {
    // These must stay visible as errors -- reporting them as "needs a dev
    // build" would send the user off to rebuild over a camera permission.
    const messages = [
      'User denied camera permission',
      'Failed to write cropped image to disk',
      'Out of memory',
    ];
    for (const m of messages) {
      assert.ok(!isMissingNativeModule(m), `should not have matched: ${m}`);
    }
  });
});
