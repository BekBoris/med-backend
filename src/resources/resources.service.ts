import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Model, Schema } from 'mongoose';
import { ENTITY_COLLECTIONS, ResourceEntityName } from '../common/constants/entities.constant';
import { ResourceQueryDto } from '../common/dto/resource-query.dto';
import { PhiCryptoService } from '../security/phi-crypto.service';
import { getResourceProtectionPolicy } from '../security/resource-protection.constants';
import {
  buildMongoFilter,
  buildMongoSort,
  createEntityIdentifier,
  parseFilter,
  serializeDocument,
  serializeDocuments,
} from '../common/utils/entity.utils';

type LooseResourceDocument = Record<string, unknown>;

const resourceSchema = new Schema<LooseResourceDocument>(
  {
    id: { type: String, index: true },
    created_date: { type: String, index: true },
    updated_date: { type: String, index: true },
  },
  {
    strict: false,
    minimize: false,
    versionKey: false,
  },
);

@Injectable()
export class ResourcesService {
  private readonly models = new Map<ResourceEntityName, Model<LooseResourceDocument>>();

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly phiCryptoService: PhiCryptoService,
  ) {}

  private getModel(entityName: ResourceEntityName) {
    if (this.models.has(entityName)) {
      return this.models.get(entityName)!;
    }

    const modelName = `Resource${entityName}`;
    const existingModel = this.connection.models[modelName] as
      | Model<LooseResourceDocument>
      | undefined;

    const policy = getResourceProtectionPolicy(entityName);
    const schema = resourceSchema.clone();
    Object.values(policy?.blindIndexes || {}).forEach((fieldName) => {
      schema.index({ [fieldName]: 1 });
    });

    const model =
      existingModel ??
      this.connection.model<LooseResourceDocument>(
        modelName,
        schema,
        ENTITY_COLLECTIONS[entityName],
      );

    this.models.set(entityName, model);
    return model;
  }

  async list(entityName: ResourceEntityName, query: ResourceQueryDto) {
    const model = this.getModel(entityName);
    const filter = this.translateFilter(entityName, parseFilter(query.filter));
    const mongoFilter = buildMongoFilter(filter);
    const sortField = this.getSortField(query.sort);
    const requiresInMemorySort = sortField
      ? this.isProtectedField(entityName, sortField)
      : false;

    if (requiresInMemorySort) {
      const records = await model.find(mongoFilter).lean();
      const decryptedRecords = serializeDocuments(records).map((record) =>
        this.prepareResourceForRead(entityName, record),
      ).filter((record): record is LooseResourceDocument => Boolean(record));

      return this.applyPagination(
        this.sortResources(decryptedRecords, query.sort),
        query.offset ?? 0,
        query.limit,
      );
    }

    let cursor = model.find(mongoFilter).sort(buildMongoSort(query.sort)).skip(query.offset ?? 0);
    if (typeof query.limit === 'number') {
      cursor = cursor.limit(query.limit);
    }

    const records = await cursor.lean();
    return serializeDocuments(records).map((record) =>
      this.prepareResourceForRead(entityName, record),
    );
  }

  async get(entityName: ResourceEntityName, id: string) {
    const model = this.getModel(entityName);
    const record = await model.findOne({ id }).lean();
    if (!record) {
      throw new NotFoundException(`${entityName} "${id}" was not found.`);
    }

    return this.prepareResourceForRead(entityName, serializeDocument(record));
  }

  async create(entityName: ResourceEntityName, payload: LooseResourceDocument) {
    const model = this.getModel(entityName);
    const timestamp = new Date().toISOString();
    const protectedPayload = this.prepareResourceForWrite(entityName, payload);
    const record = {
      ...protectedPayload,
      id:
        typeof protectedPayload.id === 'string'
          ? protectedPayload.id
          : createEntityIdentifier(entityName),
      created_date:
        typeof protectedPayload.created_date === 'string'
          ? protectedPayload.created_date
          : timestamp,
      updated_date: timestamp,
    };

    const created = await model.create(record);
    return this.prepareResourceForRead(entityName, serializeDocument(created.toObject()));
  }

  async bulkCreate(entityName: ResourceEntityName, items: LooseResourceDocument[]) {
    const model = this.getModel(entityName);
    const timestamp = new Date().toISOString();
    const records = items.map((item) => {
      const protectedItem = this.prepareResourceForWrite(entityName, item);
      return {
        ...protectedItem,
        id:
          typeof protectedItem.id === 'string'
            ? protectedItem.id
            : createEntityIdentifier(entityName),
        created_date:
          typeof protectedItem.created_date === 'string'
            ? protectedItem.created_date
            : timestamp,
        updated_date: timestamp,
      };
    });

    const created = await model.insertMany(records, { ordered: true });
    return created.map((document) =>
      this.prepareResourceForRead(entityName, serializeDocument(document.toObject())),
    );
  }

  async update(entityName: ResourceEntityName, id: string, updates: LooseResourceDocument) {
    const model = this.getModel(entityName);
    const protectedUpdates = this.prepareResourceForWrite(entityName, updates);
    const record = await model.findOneAndUpdate(
      { id },
      {
        $set: {
          ...protectedUpdates,
          id,
          updated_date: new Date().toISOString(),
        },
      },
      { new: true },
    );

    if (!record) {
      throw new NotFoundException(`${entityName} "${id}" was not found.`);
    }

    return this.prepareResourceForRead(entityName, serializeDocument(record.toObject()));
  }

  async delete(entityName: ResourceEntityName, id: string) {
    const model = this.getModel(entityName);
    const result = await model.deleteOne({ id });
    if (!result.deletedCount) {
      throw new NotFoundException(`${entityName} "${id}" was not found.`);
    }

    return { success: true };
  }

  private prepareResourceForWrite(
    entityName: ResourceEntityName,
    payload: LooseResourceDocument,
  ): LooseResourceDocument {
    const policy = getResourceProtectionPolicy(entityName);
    if (!policy) {
      return payload;
    }

    const nextPayload = { ...payload };
    Object.values(policy.blindIndexes || {}).forEach((fieldName) => {
      delete nextPayload[fieldName];
    });

    policy.protectedFields.forEach((fieldName) => {
      if (!(fieldName in nextPayload)) {
        return;
      }

      const value = nextPayload[fieldName];
      nextPayload[fieldName] = this.phiCryptoService.encryptValue(value);

      const blindIndexField = policy.blindIndexes?.[fieldName];
      if (!blindIndexField) {
        return;
      }

      const blindIndex = this.phiCryptoService.buildBlindIndex(value);
      if (blindIndex) {
        nextPayload[blindIndexField] = blindIndex;
      } else {
        delete nextPayload[blindIndexField];
      }
    });

    return nextPayload;
  }

  private prepareResourceForRead(
    entityName: ResourceEntityName,
    payload: LooseResourceDocument | null,
  ): LooseResourceDocument | null {
    if (!payload) {
      return payload;
    }

    const policy = getResourceProtectionPolicy(entityName);
    if (!policy) {
      return payload;
    }

    const nextPayload = { ...payload };
    policy.protectedFields.forEach((fieldName) => {
      if (!(fieldName in nextPayload)) {
        return;
      }

      nextPayload[fieldName] = this.phiCryptoService.decryptValue(nextPayload[fieldName]);
    });
    Object.values(policy.blindIndexes || {}).forEach((fieldName) => {
      delete nextPayload[fieldName];
    });

    return nextPayload;
  }

  private translateFilter(
    entityName: ResourceEntityName,
    filter: Record<string, unknown>,
  ): Record<string, unknown> {
    const policy = getResourceProtectionPolicy(entityName);
    if (!policy || Object.keys(filter).length === 0) {
      return filter;
    }

    return Object.fromEntries(
      Object.entries(filter).map(([fieldName, value]) => {
        if (!this.isProtectedField(entityName, fieldName)) {
          return [fieldName, value];
        }

        const blindIndexField = policy.blindIndexes?.[fieldName];
        if (!blindIndexField) {
          throw new BadRequestException(
            `Filtering by encrypted field "${fieldName}" is not supported.`,
          );
        }

        return [blindIndexField, this.translateBlindIndexFilter(value, fieldName)];
      }),
    );
  }

  private translateBlindIndexFilter(value: unknown, fieldName: string) {
    if (Array.isArray(value)) {
      return { $in: value.map((item) => this.phiCryptoService.buildBlindIndex(item)) };
    }

    if (value && typeof value === 'object') {
      const filterObject = value as Record<string, unknown>;
      if (Array.isArray(filterObject.$in)) {
        return {
          $in: filterObject.$in.map((item) => this.phiCryptoService.buildBlindIndex(item)),
        };
      }

      throw new BadRequestException(
        `Filtering by encrypted field "${fieldName}" only supports exact matches.`,
      );
    }

    return this.phiCryptoService.buildBlindIndex(value);
  }

  private isProtectedField(entityName: ResourceEntityName, fieldName: string) {
    return getResourceProtectionPolicy(entityName)?.protectedFields.includes(fieldName) ?? false;
  }

  private getSortField(sortBy?: string) {
    if (!sortBy) {
      return null;
    }

    return sortBy.startsWith('-') ? sortBy.slice(1) : sortBy;
  }

  private sortResources(records: LooseResourceDocument[], sortBy?: string) {
    const sortField = this.getSortField(sortBy);
    if (!sortField) {
      return records;
    }

    const direction = sortBy?.startsWith('-') ? -1 : 1;
    return [...records].sort(
      (left, right) =>
        direction * this.compareValues(left[sortField], right[sortField]),
    );
  }

  private compareValues(left: unknown, right: unknown) {
    if (left == null && right == null) {
      return 0;
    }

    if (left == null) {
      return 1;
    }

    if (right == null) {
      return -1;
    }

    if (typeof left === 'number' && typeof right === 'number') {
      return left - right;
    }

    return String(left).localeCompare(String(right), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  }

  private applyPagination(
    records: LooseResourceDocument[],
    offset: number,
    limit?: number,
  ) {
    const sliced = offset > 0 ? records.slice(offset) : records;
    if (typeof limit !== 'number') {
      return sliced;
    }

    return sliced.slice(0, limit);
  }
}
