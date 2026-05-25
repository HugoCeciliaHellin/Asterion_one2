/**
 * Browser-side cryptographic signing module using Ed25519 (tweetnacl-js).
 * Implements canonical JSON sorting and SHA-256 hashing to ensure exact 
 * byte-sequence compatibility with the flight software's verification.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';


const STORAGE_KEY = 'asterion_ed25519_keypair';

/**
 * Generate a new Ed25519 keypair.
 * @returns {{ publicKey: string, secretKey: string }} Base64-encoded keys
 */
export function generateKeypair() {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: encodeBase64(kp.publicKey),
    secretKey: encodeBase64(kp.secretKey),
  };
}

/**
 * @returns {{ publicKey: string, secretKey: string }}
 */
export function loadOrCreateKeypair() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Validate the stored keypair is usable
      if (parsed.publicKey && parsed.secretKey) {
        // Verify key lengths (Ed25519: 32 bytes public, 64 bytes secret)
        const pubBytes = decodeBase64(parsed.publicKey);
        const secBytes = decodeBase64(parsed.secretKey);
        if (pubBytes.length === 32 && secBytes.length === 64) {
          return parsed;
        }
      }
    }
  } catch {
    // Corrupted storage — regenerate
  }

  const kp = generateKeypair();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(kp));
  } catch {
    // localStorage unavailable — key lives only in memory this session
  }
  return kp;
}

/**
 * Get the current public key (Base64).
 * @returns {string}
 */
export function getPublicKey() {
  return loadOrCreateKeypair().publicKey;
}



/**

 * @param {*} obj - Object to serialize
 * @returns {string} Canonical JSON string
 */
export function canonicalJSON(obj) {
  return JSON.stringify(sortDeep(obj));
}

/**
 * Recursively sort all object keys.
 * Arrays preserve element order but sort keys within each element.
 * @param {*} value
 * @returns {*}
 */
function sortDeep(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortDeep(value[key]);
    }
    return sorted;
  }
  return value;
}



/**
 * Compute SHA-256 hash of a string.
 * Uses the browser's native Web Crypto API.
 *
 * @param {string} data - Input string
 * @returns {Promise<Uint8Array>} SHA-256 digest (32 bytes)
 */
export async function sha256(data) {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return new Uint8Array(hashBuffer);
}

/**
 * Compute SHA-256 hash and return as hex string.
 * @param {string} data
 * @returns {Promise<string>} Hex-encoded hash (64 chars)
 */
export async function sha256Hex(data) {
  const bytes = await sha256(data);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}


/**
 * Sign a command plan's commands array.
 * Implements SD-1C steps ①②③:
 *
 * @param {Array} commands - Array of command objects [{command_type, payload}, ...]
 * @param {string} [secretKeyB64] - Base64-encoded Ed25519 secret key (64 bytes).
 *                                   If omitted, uses the stored keypair.
 * @returns {Promise<{ signature: string, publicKey: string, payloadHash: string }>}
 */
export async function signCommands(commands, secretKeyB64 = null) {
  // Load keypair
  const keypair = secretKeyB64
    ? { secretKey: secretKeyB64, publicKey: null }
    : loadOrCreateKeypair();

  const secretKey = decodeBase64(keypair.secretKey);

  // ① Canonical JSON
  const canonical = canonicalJSON(commands);

  // ② SHA-256 of canonical
  const payloadHash = await sha256(canonical);
  const payloadHashHex = Array.from(payloadHash)
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  const signatureBytes = nacl.sign.detached(payloadHash, secretKey);

  // Derive public key from secret key if not provided
  const publicKeyB64 = keypair.publicKey ||
    encodeBase64(nacl.sign.keyPair.fromSecretKey(secretKey).publicKey);

  return {
    signature: encodeBase64(signatureBytes),
    publicKey: publicKeyB64,
    payloadHash: payloadHashHex,
  };
}


/**
 * Verify an Ed25519 signature locally (browser-side).
 * This mirrors what crypto_verifier.py does on the Flight side.
 *
 * @param {Array} commands 
 * @param {string} signatureB64 
 * @param {string} publicKeyB64 
 * @returns {Promise<boolean>} 
 */
export async function verifySignature(commands, signatureB64, publicKeyB64) {
  try {
    const canonical = canonicalJSON(commands);
    const payloadHash = await sha256(canonical);
    const signature = decodeBase64(signatureB64);
    const publicKey = decodeBase64(publicKeyB64);

    return nacl.sign.detached.verify(payloadHash, signature, publicKey);
  } catch {
    return false;
  }
}


export default {
  generateKeypair,
  loadOrCreateKeypair,
  getPublicKey,
  canonicalJSON,
  sha256,
  sha256Hex,
  signCommands,
  verifySignature,
};
