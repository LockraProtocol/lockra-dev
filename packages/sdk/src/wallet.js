// Optional wallet signatures (EIP-191 personal_sign), compatible with lockra.buzz.
// The signed message commits to the exact capsule (token + label + signer name), so a
// signature cannot be moved to another capsule and the label cannot be swapped afterwards.
// The SDK never handles private keys: sign `walletMessage()` with your own wallet library.

import { secp256k1 } from './vendor/curves/secp256k1.js';
import { keccak_256 } from './vendor/hashes/sha3.js';
import { sha256 } from './vendor/hashes/sha256.js';
import { decodeToken } from './token.js';
import { hex, unhex, utf8, cat } from './bytes.js';

/** The exact text a wallet signs to vouch for a capsule. */
export function walletMessage({ token, label = '', by = '' }) {
  const { round } = decodeToken(token);
  const digest = hex(sha256(utf8(`${token}\u0000${label}\u0000${by}`)));
  return `LOCKRA capsule\nRound: ${round}\nLabel: ${label || '(none)'}\nCapsule: 0x${digest}`;
}

/** Recover the address that produced an EIP-191 signature over `message`. */
export function recoverAddress(message, signatureHex) {
  const m = utf8(message);
  const digest = keccak_256(cat(utf8(`\x19Ethereum Signed Message:\n${m.length}`), m));
  const b = unhex(signatureHex);
  if (b.length !== 65) throw new TypeError('signature must be 65 bytes');
  let v = b[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new TypeError('invalid recovery id');
  const sig = secp256k1.Signature.fromCompact(b.slice(0, 64)).addRecoveryBit(v);
  const pub = sig.recoverPublicKey(digest).toRawBytes(false);
  return '0x' + hex(keccak_256(pub.slice(1)).slice(-20));
}

/**
 * Verify the wallet signature attached to a capsule, if any.
 * @returns {{ address: string, verified: boolean } | null}
 */
export function verifyWallet(ref) {
  if (!ref.address || !ref.signature) return null;
  try {
    const who = recoverAddress(walletMessage(ref), ref.signature);
    return { address: ref.address.toLowerCase(), verified: who.toLowerCase() === ref.address.toLowerCase() };
  } catch {
    return { address: ref.address.toLowerCase(), verified: false };
  }
}
