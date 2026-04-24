import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
