import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { basename, extname, join, normalize, resolve } from 'path';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { extension as extensionForMime, lookup } from 'mime-types';
import pdfParse from 'pdf-parse';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const safeJoinUrl = (baseUrl: string, path: string) => {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ''), normalizedBase).toString();
};

const sanitizeFileName = (fileName: string) => {
  const extension = extname(fileName);
  const name = basename(fileName, extension)
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return `${name || 'file'}${extension || ''}`;
};

@Injectable()
export class FilesService {
  private readonly uploadsRoot = resolve(process.cwd(), 'uploads');
  private readonly signingSecret: string;
  private s3Client?: S3Client;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {
    this.signingSecret = this.configService.get<string>(
      'FILE_SIGNING_SECRET',
      this.configService.get<string>('JWT_SECRET', 'development-secret'),
    );
  }

  async ensureDirectories() {
    await mkdir(join(this.uploadsRoot, 'public'), { recursive: true });
    await mkdir(join(this.uploadsRoot, 'private'), { recursive: true });
  }

  private toExternalUrl(path: string) {
    const publicUrl = this.configService.get<string>('APP_PUBLIC_URL');
    if (!publicUrl) {
      return path;
    }

    return safeJoinUrl(publicUrl, path);
  }

  private getAwsRegion() {
    return this.configService.get<string>('AWS_REGION', 'us-west-1');
  }

  private getS3Bucket() {
    const bucket = this.configService.get<string>('AWS_S3_BUCKET');
    if (!bucket) {
      throw new BadRequestException('AWS_S3_BUCKET is not configured.');
    }

    return bucket;
  }

  private getS3Client() {
    if (!this.s3Client) {
      this.s3Client = new S3Client({ region: this.getAwsRegion() });
    }

    return this.s3Client;
  }

  private normalizeS3Folder(folder: string) {
    return folder
      .replace(/^\/+|\/+$/g, '')
      .replace(/[^a-zA-Z0-9/_-]+/g, '-')
      .replace(/\/{2,}/g, '/')
      .slice(0, 120) || 'uploads';
  }

  private isS3Reference(reference: string) {
    return reference.startsWith('s3://');
  }

  verifyUploadReference(uploadRef: string) {
    if (!uploadRef) {
      throw new BadRequestException('upload_ref is required.');
    }

    try {
      const payload = this.jwtService.verify<{
        fileUri?: string;
        fileName?: string;
        mimeType?: string;
      }>(uploadRef, {
        secret: this.signingSecret,
      });

      if (!payload.fileUri || !this.isS3Reference(payload.fileUri)) {
        throw new UnauthorizedException('Invalid upload reference.');
      }

      return {
        fileUri: payload.fileUri,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException('Invalid or expired upload reference.');
    }
  }

  parseS3Reference(reference: string) {
    if (!this.isS3Reference(reference)) {
      throw new BadRequestException('Unsupported S3 file reference.');
    }

    const parsed = new URL(reference);
    const bucket = parsed.hostname;
    const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    if (!bucket || !key) {
      throw new BadRequestException('Invalid S3 file reference.');
    }

    return { bucket, key };
  }

  async createS3PresignedUpload(payload: {
    file_name?: string;
    mime_type?: string;
    folder?: string;
    expires_in?: number;
  }) {
    const mimeType = payload.mime_type || 'application/octet-stream';
    const allowedMimeTypes = new Set([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/tiff',
      'text/plain',
      'text/csv',
    ]);

    if (!allowedMimeTypes.has(mimeType)) {
      throw new BadRequestException('Unsupported file type for secure upload.');
    }

    const bucket = this.getS3Bucket();
    const expiresIn = Math.min(Math.max(payload.expires_in ?? 300, 60), 900);
    const safeOriginalName = sanitizeFileName(payload.file_name || 'upload');
    const extension =
      extname(safeOriginalName).toLowerCase() ||
      `.${extensionForMime(mimeType) || 'bin'}`;
    const folder = this.normalizeS3Folder(payload.folder || 'eob');
    const objectKey = `${folder}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}${extension}`;
    const fileUri = `s3://${bucket}/${objectKey}`;
    const uploadRef = this.jwtService.sign(
      {
        fileUri,
        fileName: safeOriginalName,
        mimeType,
      },
      {
        secret: this.signingSecret,
        expiresIn: '1h',
      },
    );
    const kmsKeyId = this.configService.get<string>('AWS_S3_KMS_KEY_ID');
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ContentType: mimeType,
      ServerSideEncryption: kmsKeyId ? 'aws:kms' : undefined,
      SSEKMSKeyId: kmsKeyId,
    });
    const uploadUrl = await getSignedUrl(this.getS3Client(), command, {
      expiresIn,
    });
    const headers: Record<string, string> = {
      'Content-Type': mimeType,
    };

    if (kmsKeyId) {
      headers['x-amz-server-side-encryption'] = 'aws:kms';
      headers['x-amz-server-side-encryption-aws-kms-key-id'] = kmsKeyId;
    }

    return {
      upload_url: uploadUrl,
      upload_ref: uploadRef,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      headers,
    };
  }

  private normalizeFileUri(fileUri: string) {
    return decodeURIComponent(fileUri).replace(/^\/+/, '');
  }

  private toAbsolutePath(fileUri: string) {
    const normalizedUri = normalize(this.normalizeFileUri(fileUri));
    const absolutePath = resolve(this.uploadsRoot, normalizedUri);
    if (!absolutePath.startsWith(this.uploadsRoot)) {
      throw new BadRequestException('Invalid file reference.');
    }

    return absolutePath;
  }

  verifySignedToken(token: string) {
    try {
      return this.jwtService.verify<{ fileUri: string }>(token, {
        secret: this.signingSecret,
      });
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired signed file URL.');
    }
  }

  resolveFileUriFromReference(reference: string) {
    if (!reference) {
      throw new BadRequestException('A file reference is required.');
    }

    if (reference.startsWith('public/') || reference.startsWith('private/')) {
      return this.normalizeFileUri(reference);
    }

    let pathName = reference;
    if (/^https?:\/\//i.test(reference)) {
      pathName = new URL(reference).pathname;
    }

    if (pathName.startsWith('/')) {
      if (pathName.startsWith('/api/files/public/')) {
        return `public/${decodeURIComponent(pathName.replace('/api/files/public/', ''))}`;
      }

      if (pathName.startsWith('/api/files/signed/')) {
        const token = pathName.replace('/api/files/signed/', '');
        return this.verifySignedToken(token).fileUri;
      }

      if (pathName.startsWith('/api/files/private/')) {
        return `private/${decodeURIComponent(pathName.replace('/api/files/private/', ''))}`;
      }
    }

    throw new BadRequestException('Unsupported file reference.');
  }

  async getFileMetaFromReference(reference: string) {
    if (this.isS3Reference(reference)) {
      const { bucket, key } = this.parseS3Reference(reference);
      const result = await this.getS3Client()
        .send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        .catch(() => {
          throw new NotFoundException('File not found.');
        });

      return {
        fileUri: reference,
        bucket,
        key,
        size: result.ContentLength || 0,
        mimeType: result.ContentType || lookup(key) || 'application/octet-stream',
        fileName: basename(key),
      };
    }

    const fileUri = this.resolveFileUriFromReference(reference);
    const absolutePath = this.toAbsolutePath(fileUri);
    const fileStats = await stat(absolutePath).catch(() => {
      throw new NotFoundException('File not found.');
    });

    return {
      fileUri,
      absolutePath,
      size: fileStats.size,
      mimeType: lookup(absolutePath) || 'application/octet-stream',
      fileName: basename(absolutePath),
    };
  }

  async readFileBuffer(reference: string) {
    if (this.isS3Reference(reference)) {
      const { bucket, key } = this.parseS3Reference(reference);
      const result = await this.getS3Client().send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const body = result.Body as
        | {
            transformToByteArray?: () => Promise<Uint8Array>;
          }
        | undefined;

      if (!body?.transformToByteArray) {
        throw new BadRequestException('Unable to read S3 object body.');
      }

      return Buffer.from(await body.transformToByteArray());
    }

    const meta = await this.getFileMetaFromReference(reference);
    if (!meta.absolutePath) {
      throw new BadRequestException('Local file path is unavailable.');
    }

    return readFile(meta.absolutePath);
  }

  async readTextFromReference(reference: string) {
    if (this.isS3Reference(reference)) {
      const buffer = await this.readFileBuffer(reference);
      return buffer.toString('utf8');
    }

    const meta = await this.getFileMetaFromReference(reference);
    if (!meta.absolutePath) {
      throw new BadRequestException('S3 text extraction must use Textract.');
    }

    if (meta.mimeType === 'application/pdf' || meta.fileName.toLowerCase().endsWith('.pdf')) {
      const buffer = await readFile(meta.absolutePath);
      const parsedPdf = await pdfParse(buffer);
      return parsedPdf.text || '';
    }

    return readFile(meta.absolutePath, 'utf8');
  }

  async storeFile(file: Express.Multer.File, visibility: 'public' | 'private') {
    if (!file) {
      throw new BadRequestException('File upload is required.');
    }

    await this.ensureDirectories();

    const safeOriginalName = sanitizeFileName(file.originalname || 'upload');
    const storedName = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeOriginalName}`;
    const fileUri = `${visibility}/${storedName}`;
    const absolutePath = this.toAbsolutePath(fileUri);

    await writeFile(absolutePath, file.buffer);

    return {
      file_uri: fileUri,
      file_url:
        visibility === 'public'
          ? this.toExternalUrl(`/api/files/public/${encodeURIComponent(storedName)}`)
          : undefined,
      original_name: file.originalname,
      mime_type: file.mimetype,
      size: file.size,
    };
  }

  createSignedUrl(fileUri: string, expiresIn = 3600) {
    if (this.isS3Reference(fileUri)) {
      const { bucket, key } = this.parseS3Reference(fileUri);
      const safeExpiresIn = Math.min(Math.max(expiresIn, 60), 3600);

      return getSignedUrl(
        this.getS3Client(),
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: safeExpiresIn },
      ).then((signedUrl) => ({
        signed_url: signedUrl,
        expires_at: new Date(Date.now() + safeExpiresIn * 1000).toISOString(),
      }));
    }

    const token = this.jwtService.sign(
      { fileUri: this.normalizeFileUri(fileUri) },
      {
        secret: this.signingSecret,
        expiresIn: `${expiresIn}s`,
      },
    );

    return {
      signed_url: this.toExternalUrl(`/api/files/signed/${token}`),
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }
}
