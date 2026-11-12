/**
 * Every error thrown by the SDK is a LockraError with a stable, machine-readable `code`:
 *
 * - INVALID_CAPSULE     the input is not a LOCKRA capsule, link or .lockra file
 * - INVALID_ARGUMENT    a parameter is missing or out of range
 * - TAMPERED            the capsule, its label or signer name, or the sealed file was altered
 * - BAD_SIGNATURE       a beacon signature does not match the capsule round
 * - BEACON_UNREACHABLE  no drand relay could be reached
 * - TIMEOUT             `open({ wait: true })` gave up before the capsule unlocked
 * - INTERNAL            an unexpected internal failure
 */
export class LockraError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'LockraError';
    this.code = code;
  }
}
