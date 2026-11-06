import type { SpeechPostProcessingOptions, SpeechTranscriptionOptions } from "@t3tools/contracts";
import type { VoiceDraftSnapshot } from "@t3tools/client-runtime/voice-input";
import { notifyVoiceRecordingRecoveryChange } from "./recordingRecoveryEvents";

export type SavedVoiceRecording = {
  readonly id: string;
  readonly ownerKey: string;
  /** The consent this audio was recorded under. Rows saved before grants existed have none. */
  readonly grantId?: string;
  readonly draft: VoiceDraftSnapshot;
  readonly options: SpeechTranscriptionOptions;
  readonly locale: string;
  readonly transcript?: string;
  readonly transcriptIsFinal?: boolean;
  readonly postProcessingOptions?: SpeechPostProcessingOptions;
};

// Web Locks are origin-wide and are released by the browser when a tab exits.
function voiceRecordingLockName(ownerKey: string): string {
  return `t3code:voice:${ownerKey}`;
}

export async function isVoiceRecordingLocked(ownerKey: string): Promise<boolean> {
  if (!navigator.locks) return true;
  const locks = await navigator.locks.query();
  return locks.held?.some((lock) => lock.name === voiceRecordingLockName(ownerKey)) ?? true;
}

export function acquireVoiceRecordingLock(ownerKey: string): Promise<(() => Promise<void>) | null> {
  return new Promise((resolve, reject) => {
    if (!navigator.locks) {
      reject(new Error("This browser cannot safely retain dictation across tabs."));
      return;
    }
    let unlock!: () => void;
    const released = new Promise<void>((accept) => {
      unlock = accept;
    });
    const request = navigator.locks.request(
      voiceRecordingLockName(ownerKey),
      { ifAvailable: true },
      (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        resolve(async () => {
          unlock();
          await request;
        });
        return released;
      },
    );
    void request.catch(reject);
  });
}

const DATABASE = "t3code:voice-recordings";
const RECORDINGS = "recordings";
const CHUNKS = "chunks";

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.addEventListener("upgradeneeded", () => {
      request.result
        .createObjectStore(RECORDINGS, { keyPath: "id" })
        .createIndex("ownerKey", "ownerKey");
      request.result
        .createObjectStore(CHUNKS, { keyPath: ["id", "sequence"] })
        .createIndex("id", "id");
    });
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("success", () => resolve(request.result));
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  run: (transaction: IDBTransaction, result: (value: T) => void) => void,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      // Acknowledged chunks must reach disk before capture considers them saved.
      const transaction = database.transaction([RECORDINGS, CHUNKS], mode, {
        durability: "strict",
      });
      let value: T;
      transaction.addEventListener("complete", () => resolve(value));
      transaction.addEventListener("abort", () =>
        reject(transaction.error ?? new Error("Saving voice recording failed.")),
      );
      transaction.addEventListener("error", () => reject(transaction.error));
      run(transaction, (next) => {
        value = next;
      });
    });
  } finally {
    database.close();
  }
}

export const recordingStorage = {
  create(recording: SavedVoiceRecording): Promise<void> {
    return transact<void>("readwrite", (tx) => {
      const store = tx.objectStore(RECORDINGS);
      const existing = store.index("ownerKey").getKey(recording.ownerKey);
      existing.addEventListener("success", () => {
        // Separate tabs must not start a second recording over an unfinished one.
        if (existing.result !== undefined) tx.abort();
        else store.add(recording);
      });
    }).then(notifyVoiceRecordingRecoveryChange);
  },
  append(id: string, sequence: number, pcm: Float32Array<ArrayBuffer>): Promise<void> {
    return transact("readwrite", (tx) => {
      const request = tx.objectStore(RECORDINGS).getKey(id);
      request.addEventListener("success", () => {
        if (request.result === undefined) tx.abort();
        else tx.objectStore(CHUNKS).add({ id, sequence, pcm });
      });
    });
  },
  saveTranscript(
    id: string,
    transcript: string,
    transcriptIsFinal = false,
    draft?: VoiceDraftSnapshot,
  ): Promise<void> {
    return transact<void>("readwrite", (tx) => {
      const store = tx.objectStore(RECORDINGS);
      const request = store.get(id);
      request.addEventListener("success", () => {
        if (request.result)
          store.put({
            ...request.result,
            transcript,
            transcriptIsFinal,
            ...(draft ? { draft } : {}),
          });
      });
    }).then(notifyVoiceRecordingRecoveryChange);
  },
  listByOwnerPrefix(prefix: string): Promise<SavedVoiceRecording[]> {
    return transact("readonly", (tx, result) => {
      const request = tx
        .objectStore(RECORDINGS)
        .index("ownerKey")
        .getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.addEventListener("success", () => result(request.result as SavedVoiceRecording[]));
    });
  },
  find(ownerKey: string): Promise<SavedVoiceRecording | null> {
    return transact("readonly", (tx, result) => {
      const request = tx.objectStore(RECORDINGS).index("ownerKey").get(ownerKey);
      request.addEventListener("success", () =>
        result((request.result as SavedVoiceRecording | undefined) ?? null),
      );
    });
  },
  audio(id: string): Promise<Blob> {
    return transact("readonly", (tx, result) => {
      const request = tx.objectStore(CHUNKS).index("id").getAll(id);
      request.addEventListener("success", () => {
        const chunks = request.result as Array<{
          sequence: number;
          pcm: Float32Array<ArrayBuffer>;
        }>;
        chunks.sort((a, b) => a.sequence - b.sequence);
        result(
          new Blob(
            chunks.map((chunk) => chunk.pcm),
            { type: "application/octet-stream" },
          ),
        );
      });
    });
  },
  remove(id: string): Promise<void> {
    return transact<void>("readwrite", (tx) => {
      tx.objectStore(RECORDINGS).delete(id);
      const request = tx.objectStore(CHUNKS).index("id").openKeyCursor(IDBKeyRange.only(id));
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (!cursor) return;
        tx.objectStore(CHUNKS).delete(cursor.primaryKey);
        cursor.continue();
      });
    }).then(notifyVoiceRecordingRecoveryChange);
  },
};
