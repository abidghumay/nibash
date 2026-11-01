import { AppError } from "../errors/AppError.js";

export const DOCUMENT_BUCKET = "verification-documents";
export const DOCUMENT_URL_TTL_SECONDS = 300;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new AppError(503, "Document storage is not configured");
  return { url: url.replace(/\/$/, ""), headers: { apikey: key, Authorization: `Bearer ${key}` } };
}

function objectPath(path: string) {
  if (!path.startsWith("documents/") || path.split("/").some(p => !p || p === "." || p === "..")) {
    throw new AppError(500, "Invalid document storage path");
  }
  return path.split("/").map(encodeURIComponent).join("/");
}

async function storageRequest(path: string, init: RequestInit = {}) {
  const { url, headers } = config();
  const response = await fetch(`${url}/storage/v1/${path}`, {
    ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new AppError(503, `Document storage request failed (${response.status})`);
  return response;
}

// Fail closed if a deployment accidentally creates a public document bucket.
export async function assertPrivateDocumentBucket() {
  const bucket = await (await storageRequest(`bucket/${DOCUMENT_BUCKET}`)).json() as { public?: boolean };
  if (bucket.public !== false) throw new AppError(503, "Document bucket must be private");
}

export async function uploadPrivateDocument(path: string, buffer: Buffer, mimeType: string) {
  await assertPrivateDocumentBucket();
  await storageRequest(`object/${DOCUMENT_BUCKET}/${objectPath(path)}`, {
    method: "POST", headers: { "Content-Type": mimeType, "x-upsert": "false" },
    body: buffer as unknown as BodyInit,
  });
}

export async function signDocumentUrl(bucket: string, path: string) {
  if (bucket !== DOCUMENT_BUCKET) throw new AppError(503, "Legacy documents must be migrated to private storage");
  await assertPrivateDocumentBucket();
  const data = await (await storageRequest(`object/sign/${DOCUMENT_BUCKET}/${objectPath(path)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: DOCUMENT_URL_TTL_SECONDS }),
  })).json() as { signedURL: string };
  // Supabase returns a path relative to /storage/v1.
  if (!data.signedURL?.startsWith(`/object/sign/${DOCUMENT_BUCKET}/`)) {
    throw new AppError(503, "Invalid signed document URL");
  }
  return `${config().url}/storage/v1${data.signedURL}`;
}

export async function downloadDocument(bucket: string, path: string) {
  if (bucket !== DOCUMENT_BUCKET && bucket !== "listing-images") throw new AppError(500, "Invalid document bucket");
  const response = await storageRequest(`object/authenticated/${bucket}/${objectPath(path)}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new AppError(400, "Document exceeds 5 MB");
  return buffer;
}

export async function deleteDocumentObject(bucket: string, path: string) {
  if (bucket !== DOCUMENT_BUCKET && bucket !== "listing-images") throw new AppError(500, "Invalid document bucket");
  objectPath(path);
  await storageRequest(`object/${bucket}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: [path] }),
  });
}
