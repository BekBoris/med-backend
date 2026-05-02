import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IntegrationsService } from './integrations.service';

@ApiTags('integrations')
@Controller('integrations/core')
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  @Post('upload-file')
  uploadFile(@UploadedFile() file: Express.Multer.File) {
    return this.integrationsService.uploadFile(file);
  }

  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  @Post('upload-private-file')
  uploadPrivateFile(@UploadedFile() file: Express.Multer.File) {
    return this.integrationsService.uploadPrivateFile(file);
  }

  @Post('create-file-signed-url')
  createFileSignedUrl(@Body() body: { file_uri?: string; expires_in?: number }) {
    return this.integrationsService.createFileSignedUrl(body);
  }

  @Post('create-s3-upload-url')
  createS3UploadUrl(
    @Body()
    body: {
      file_name?: string;
      mime_type?: string;
      folder?: string;
      expires_in?: number;
    },
  ) {
    return this.integrationsService.createS3UploadUrl(body);
  }

  @Post('create-eob-batch-from-upload')
  createEobBatchFromUpload(
    @Body() body: { upload_ref?: string; batch?: Record<string, unknown> },
  ) {
    return this.integrationsService.createEobBatchFromUpload(body);
  }

  @Post('extract-data-from-eob-batch')
  extractDataFromEobBatch(
    @Body() body: { batch_id?: string; json_schema?: Record<string, unknown> },
  ) {
    return this.integrationsService.extractDataFromEobBatch(body);
  }

  @Post('extract-data-from-uploaded-file')
  extractDataFromUploadedFile(
    @Body() body: { file_url?: string; upload_ref?: string; json_schema?: Record<string, unknown> },
  ) {
    return this.integrationsService.extractDataFromUploadedFile(body);
  }

  @Post('extract-and-store-eob')
  extractAndStoreEobFromUploadedFile(
    @Body() body: { file_uri?: string; upload_ref?: string; file_name?: string; json_schema?: Record<string, unknown> },
  ) {
    return this.integrationsService.extractAndStoreEobFromUploadedFile(body);
  }

  @Post('invoke-llm')
  invokeLlm(
    @Body()
    body: {
      prompt?: string;
      file_urls?: string[];
      response_json_schema?: Record<string, unknown>;
    },
  ) {
    return this.integrationsService.invokeLLM(body);
  }

  @Post('match-eob-lines-to-claims')
  matchEobLinesToClaims(
    @Body() body: { eob_lines?: Record<string, unknown>[]; claims?: Record<string, unknown>[] },
  ) {
    return this.integrationsService.matchEobLinesToClaims(body);
  }
}
