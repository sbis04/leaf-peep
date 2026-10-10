// Photo storage: DigitalOcean Spaces when SPACES_BUCKET is set, local disk otherwise.
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const BUCKET = process.env.SPACES_BUCKET;
const REGION = process.env.SPACES_REGION ?? 'nyc3';
const LOCAL_DIR = path.resolve('uploads');

const s3 = BUCKET && new S3Client({
  region: 'us-east-1', // Spaces ignores this but the SDK requires one
  endpoint: `https://${REGION}.digitaloceanspaces.com`,
  credentials: { accessKeyId: process.env.SPACES_KEY, secretAccessKey: process.env.SPACES_SECRET },
});

export const localUploadsDir = LOCAL_DIR;

// Returns { key, url }. The JPEG passed in has already been re-encoded, so no EXIF/GPS survives.
export async function savePhoto(jpeg) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `sightings/${day}/${randomUUID()}.jpg`;
  if (s3) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: jpeg, ContentType: 'image/jpeg', ACL: 'public-read',
    }));
    const cdn = process.env.SPACES_CDN ?? `https://${BUCKET}.${REGION}.cdn.digitaloceanspaces.com`;
    return { key, url: `${cdn}/${key}` };
  }
  const file = path.join(LOCAL_DIR, key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, jpeg);
  return { key, url: `/uploads/${key}` };
}

export async function deletePhoto(key) {
  if (!key) return;
  if (s3) return s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  const file = path.join(LOCAL_DIR, key);
  if (!file.startsWith(LOCAL_DIR + path.sep)) return; // never step outside the uploads folder
  await unlink(file).catch((err) => { if (err.code !== 'ENOENT') throw err; });
}

export function photoUrl(key) {
  if (!key) return null;
  if (!BUCKET) return `/uploads/${key}`;
  const cdn = process.env.SPACES_CDN ?? `https://${BUCKET}.${REGION}.cdn.digitaloceanspaces.com`;
  return `${cdn}/${key}`;
}
