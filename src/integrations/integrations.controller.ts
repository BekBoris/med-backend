import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { IntegrationsService } from './integrations.service';

@ApiTags('integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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

  @Post('extract-data-from-uploaded-file')
  extractDataFromUploadedFile(
    @Body() body: { file_url?: string; json_schema?: Record<string, unknown> },
  ) {
    return this.integrationsService.extractDataFromUploadedFile(body);
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
}
