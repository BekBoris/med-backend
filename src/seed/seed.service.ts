import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import {
  DEFAULT_CLAIM_STATUSES,
  ENTITY_COLLECTIONS,
} from '../common/constants/entities.constant';
import { FilesService } from '../files/files.service';

@Injectable()
export class SeedService implements OnModuleInit {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly filesService: FilesService,
  ) {}

  async onModuleInit() {
    await this.filesService.ensureDirectories();
    await this.seedClaimStatuses();
  }

  private async seedClaimStatuses() {
    const collection = this.connection.collection(ENTITY_COLLECTIONS.ClaimStatus);
    const existingCount = await collection.countDocuments();
    if (existingCount > 0) {
      return;
    }

    const timestamp = new Date().toISOString();
    await collection.insertMany(
      DEFAULT_CLAIM_STATUSES.map((status) => ({
        ...status,
        created_date: timestamp,
        updated_date: timestamp,
      })),
    );
  }
}
