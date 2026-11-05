// Adapted from dsh-stream-retry; original MIT license retained in NOTICE.txt.
/**
 * The framework's live configuration reference. A field carrying this type is read
 * at use time, so a saved settings change takes effect without remounting the plugin.
 */
export interface Volatile<T> {
  get(): T;
}
