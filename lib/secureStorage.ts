import * as SecureStore from 'expo-secure-store';

/**
 * Supabase auth session storage backed by the device keychain/keystore.
 *
 * SecureStore rejects values over ~2048 bytes, and a Supabase session (two
 * JWTs plus user metadata) routinely exceeds that. So values are split into
 * numbered chunks, with a small index record recording how many there are.
 * AsyncStorage would sidestep the limit but stores in plaintext, which is the
 * wrong trade for an app whose session unlocks passport data.
 */

const CHUNK_SIZE = 1800; // headroom under the 2048-byte platform limit

const indexKey = (key: string) => `${key}__chunks`;
const chunkKey = (key: string, i: number) => `${key}__${i}`;

async function clearChunks(key: string): Promise<void> {
  const count = Number((await SecureStore.getItemAsync(indexKey(key))) ?? 0);
  const deletions: Promise<void>[] = [SecureStore.deleteItemAsync(indexKey(key))];
  for (let i = 0; i < count; i++) {
    deletions.push(SecureStore.deleteItemAsync(chunkKey(key, i)));
  }
  await Promise.all(deletions);
}

export const secureStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    const raw = await SecureStore.getItemAsync(indexKey(key));
    if (raw === null) return null;

    const count = Number(raw);
    if (!Number.isInteger(count) || count < 1) return null;

    const parts = await Promise.all(
      Array.from({ length: count }, (_, i) => SecureStore.getItemAsync(chunkKey(key, i)))
    );
    // A missing chunk means a partial write or partial wipe. Returning a
    // truncated string would hand Supabase corrupt JSON, so fail closed:
    // report "no session" and let the user log in again.
    if (parts.some((p) => p === null)) {
      await clearChunks(key);
      return null;
    }
    return parts.join('');
  },

  async setItem(key: string, value: string): Promise<void> {
    await clearChunks(key);

    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += CHUNK_SIZE) {
      chunks.push(value.slice(i, i + CHUNK_SIZE));
    }

    await Promise.all(
      chunks.map((chunk, i) => SecureStore.setItemAsync(chunkKey(key, i), chunk))
    );
    // Index written last: until it exists getItem reports null, so a crash
    // mid-write leaves no session rather than a half-written one.
    await SecureStore.setItemAsync(indexKey(key), String(chunks.length));
  },

  async removeItem(key: string): Promise<void> {
    await clearChunks(key);
  },
};
