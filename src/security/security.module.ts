import { Module } from '@nestjs/common';
import { PhiCryptoService } from './phi-crypto.service';

@Module({
  providers: [PhiCryptoService],
  exports: [PhiCryptoService],
})
export class SecurityModule {}
