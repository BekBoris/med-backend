import {
  Controller,
  Get,
  Head,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FilesService } from './files.service';

@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  @Post('upload')
  upload(@UploadedFile() file: Express.Multer.File) {
    return this.filesService.storeFile(file, 'public');
  }

  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  @Post('upload-private')
  uploadPrivate(@UploadedFile() file: Express.Multer.File) {
    return this.filesService.storeFile(file, 'private');
  }

  @Get('public/:fileName')
  async publicFile(@Param('fileName') fileName: string, @Res() response: Response) {
    return this.sendFile(`public/${fileName}`, response);
  }

  @Head('public/:fileName')
  async publicFileHead(@Param('fileName') fileName: string, @Res() response: Response) {
    return this.sendFileHead(`public/${fileName}`, response);
  }

  @Get('signed/:token')
  async signedFile(@Param('token') token: string, @Res() response: Response) {
    const { fileUri } = this.filesService.verifySignedToken(token);
    return this.sendFile(fileUri, response);
  }

  @Head('signed/:token')
  async signedFileHead(@Param('token') token: string, @Res() response: Response) {
    const { fileUri } = this.filesService.verifySignedToken(token);
    return this.sendFileHead(fileUri, response);
  }

  private async sendFile(reference: string, response: Response) {
    const meta = await this.filesService.getFileMetaFromReference(reference);
    response.setHeader('Content-Type', meta.mimeType);
    response.setHeader('Content-Length', String(meta.size));
    response.setHeader('Content-Disposition', `inline; filename="${meta.fileName}"`);
    return response.sendFile(meta.absolutePath);
  }

  private async sendFileHead(reference: string, response: Response) {
    const meta = await this.filesService.getFileMetaFromReference(reference);
    response.setHeader('Content-Type', meta.mimeType);
    response.setHeader('Content-Length', String(meta.size));
    response.status(200).end();
  }
}
