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
import { lookup } from 'mime-types';
import pdfParse from 'pdf-parse';

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
    const { absolutePath } = await this.getFileMetaFromReference(reference);
    return readFile(absolutePath);
  }

  async readTextFromReference(reference: string) {
    const meta = await this.getFileMetaFromReference(reference);

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
