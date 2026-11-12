// Type definitions for lockra-sdk 1.0

/** A drand beacon network running the `bls-unchained-g1-rfc9380` scheme. */
export interface Chain {
  /** Chain hash, used in relay URLs. */
  readonly hash: string;
  /** Group public key on G2, hex encoded. */
  readonly publicKey: string;
  /** Seconds between rounds. */
  readonly period: number;
  /** Unix time (seconds) of round 1. */
  readonly genesis: number;
  /** HTTP relays serving `/{hash}/public/{round}`. */
  readonly relays: readonly string[];
}

/** The public drand "quicknet" network used by lockra.buzz (3 second rounds). */
export declare const QUICKNET: Chain;

export declare const DEFAULT_BASE_URL: 'https://lockra.buzz/';
export declare const MAX_MESSAGE_LENGTH: 10000;
export declare const MAX_LABEL_LENGTH: 80;
export declare const MAX_BY_LENGTH: 40;
export declare const MAX_FILE_BYTES: number;

export type LockraErrorCode =
  | 'INVALID_CAPSULE'
  | 'INVALID_ARGUMENT'
  | 'TAMPERED'
  | 'BAD_SIGNATURE'
  | 'BEACON_UNREACHABLE'
  | 'TIMEOUT'
  | 'INTERNAL';

export declare class LockraError extends Error {
  readonly name: 'LockraError';
  readonly code: LockraErrorCode;
  constructor(code: LockraErrorCode, message: string, options?: { cause?: unknown });
}

/** When the capsule unlocks. Pass exactly one of the two. */
export type UnlockTime =
  | { /** A Date, an ISO 8601 string or epoch milliseconds. */ unlockAt: Date | string | number; unlockIn?: never }
  | { /** Seconds from now. */ unlockIn: number; unlockAt?: never };

export interface CommonOptions {
  /** Beacon network. Defaults to QUICKNET. */
  chain?: Chain;
}

export type SealOptions = UnlockTime &
  CommonOptions & {
    /** Public title shown before opening (max 80 chars). Tamper-proof. */
    label?: string;
    /** Public signer name (max 40 chars). Tamper-proof. */
    by?: string;
    /** Base URL for the generated link. Defaults to https://lockra.buzz/ */
    baseUrl?: string;
  };

export type SealFileOptions = SealOptions & {
  /** File name, revealed only when the capsule opens. */
  name: string;
  /** MIME type. Defaults to application/octet-stream. */
  type?: string;
  /** Optional message sealed together with the file. */
  message?: string;
};

export interface Capsule {
  /** The encrypted capsule (base64url). */
  token: string;
  /** Shareable link that opens on lockra.buzz. */
  link: string;
  /** drand round whose signature unlocks the capsule. */
  round: number;
  /** When the capsule unlocks. */
  unlockAt: Date;
  label: string;
  by: string;
  /** Present when a wallet signature is attached. */
  address?: string;
  signature?: string;
}

export interface WalletCheck {
  address: string;
  /** True when the signature was produced by `address` for this exact capsule. */
  verified: boolean;
}

export interface CapsuleInfo {
  round: number;
  unlockAt: Date;
  /** True once the unlock time has passed (by the local clock). */
  unlocked: boolean;
  label: string;
  by: string;
  wallet: WalletCheck | null;
}

export interface SealedResult {
  status: 'sealed';
  round: number;
  unlockAt: Date;
  secondsLeft: number;
  label: string;
  by: string;
  wallet: WalletCheck | null;
}

export interface FileInfo {
  name: string;
  type: string;
  size: number;
}

export interface OpenedResult {
  status: 'opened';
  message: string;
  round: number;
  unlockAt: Date;
  /** When the capsule was sealed, as claimed by its author. */
  sealedAt: Date | null;
  label: string;
  by: string;
  wallet: WalletCheck | null;
  /** Details of a sealed file, if the capsule contains one. */
  file: FileInfo | null;
}

export interface OpenedFileResult extends Omit<OpenedResult, 'file'> {
  file: FileInfo & { data: Uint8Array };
}

export type OpenResult = SealedResult | OpenedResult;

export interface OpenOptions extends CommonOptions {
  /** Keep waiting until the capsule unlocks instead of returning `sealed`. */
  wait?: boolean;
  /** Give up waiting after this many milliseconds (throws TIMEOUT). */
  timeoutMs?: number;
  /** Called before each wait while the capsule is still sealed. */
  onWait?: (info: { round: number; unlockAt: Date; retryInMs: number }) => void;
  /** Use a known beacon signature instead of fetching it. */
  signature?: string;
  /** Custom fetch implementation. */
  fetch?: typeof fetch;
}

/** Anything that identifies a capsule: a link, a bare token, a Capsule object or `{ "c": ... }` JSON. */
export type CapsuleInput = string | Pick<Capsule, 'token'> & Partial<Pick<Capsule, 'label' | 'by' | 'address' | 'signature'>>;

export type BinaryInput = Uint8Array | ArrayBuffer | ArrayBufferView | Blob;

/** Seal a text message until a moment in the future. */
export declare function seal(message: string, options: SealOptions): Promise<Capsule>;

/** Seal a file (up to 25 MB). Returns the capsule and the `.lockra` file bytes. */
export declare function sealFile(data: BinaryInput, options: SealFileOptions): Promise<{ capsule: Capsule; file: Uint8Array }>;

/** Try to open a capsule. */
export declare function open(capsule: CapsuleInput, options?: OpenOptions): Promise<OpenResult>;

/** Open a `.lockra` file. */
export declare function openFile(file: BinaryInput, options?: OpenOptions): Promise<SealedResult | OpenedFileResult>;

/** Read the public details of a capsule (or `.lockra` bytes) without opening it. */
export declare function inspect(capsule: CapsuleInput | Uint8Array | ArrayBuffer, options?: CommonOptions): CapsuleInfo;

/** The exact text a wallet signs (EIP-191 personal_sign) to vouch for a capsule. */
export declare function walletMessage(capsule: Pick<Capsule, 'token'> & Partial<Pick<Capsule, 'label' | 'by'>>): string;

/** Verify and attach a wallet signature. Returns a new capsule with an updated link. */
export declare function attachSignature(
  capsule: CapsuleInput,
  wallet: { address: string; signature: string },
  options?: CommonOptions & { baseUrl?: string },
): Capsule;

/** Recover the signer address of an EIP-191 signature. */
export declare function recoverAddress(message: string, signature: string): string;

/** Build a shareable link. */
export declare function toLink(
  capsule: Pick<Capsule, 'token'> & Partial<Pick<Capsule, 'label' | 'by' | 'address' | 'signature'>>,
  baseUrl?: string,
): string;

/** Normalise any capsule input into its parts. */
export declare function parseCapsule(capsule: CapsuleInput): { token: string; label: string; by: string; address?: string; signature?: string };

/** First round published at or after a unix time (seconds). */
export declare function roundAt(unixSeconds: number, chain?: Chain): number;
/** Unix time (seconds) at which a round is published. */
export declare function timeOfRound(round: number, chain?: Chain): number;
/** The latest round that should already be published. */
export declare function currentRound(chain?: Chain): number;

/** Fetch a verified beacon signature, or null while the round is not yet published. */
export declare function fetchSignature(round: number, options?: { chain?: Chain; fetch?: typeof fetch; timeoutMs?: number }): Promise<string | null>;

/** Check a beacon signature against the chain's group public key. */
export declare function verifyBeaconSignature(round: number, signature: string, chain?: Chain): boolean;
