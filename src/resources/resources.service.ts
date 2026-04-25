import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Model, Schema } from 'mongoose';
import { ENTITY_COLLECTIONS, ResourceEntityName } from '../common/constants/entities.constant';
import { ResourceQueryDto } from '../common/dto/resource-query.dto';
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

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private getModel(entityName: ResourceEntityName) {
    if (this.models.has(entityName)) {
      return this.models.get(entityName)!;
    }

    const modelName = `Resource${entityName}`;
    const existingModel = this.connection.models[modelName] as
      | Model<LooseResourceDocument>
      | undefined;

    const model =
      existingModel ??
      this.connection.model<LooseResourceDocument>(
        modelName,
        resourceSchema.clone(),
        ENTITY_COLLECTIONS[entityName],
      );

    this.models.set(entityName, model);
    return model;
  }

  async list(entityName: ResourceEntityName, query: ResourceQueryDto) {
    const model = this.getModel(entityName);
    const filter = parseFilter(query.filter);
    const mongoFilter = buildMongoFilter(filter);

    let cursor = model.find(mongoFilter).sort(buildMongoSort(query.sort)).skip(query.offset ?? 0);
    if (typeof query.limit === 'number') {
      cursor = cursor.limit(query.limit);
    }

    const records = await cursor.lean();
    return serializeDocuments(records);
  }

  async get(entityName: ResourceEntityName, id: string) {
    const model = this.getModel(entityName);
    const record = await model.findOne({ id }).lean();
    if (!record) {
      throw new NotFoundException(`${entityName} "${id}" was not found.`);
    }

    return serializeDocument(record);
  }

  async create(entityName: ResourceEntityName, payload: LooseResourceDocument) {
    const model = this.getModel(entityName);
    const timestamp = new Date().toISOString();
    const record = {
      ...payload,
      id:
        typeof payload.id === 'string'
          ? payload.id
          : createEntityIdentifier(entityName),
      created_date:
        typeof payload.created_date === 'string'
          ? payload.created_date
          : timestamp,
      updated_date: timestamp,
    };

    const created = await model.create(record);
    return serializeDocument(created.toObject());
  }

  async bulkCreate(entityName: ResourceEntityName, items: LooseResourceDocument[]) {
    const model = this.getModel(entityName);
    const timestamp = new Date().toISOString();
    const records = items.map((item) => ({
      ...item,
      id:
        typeof item.id === 'string'
          ? item.id
          : createEntityIdentifier(entityName),
      created_date:
        typeof item.created_date === 'string'
          ? item.created_date
          : timestamp,
      updated_date: timestamp,
    }));

    const created = await model.insertMany(records, { ordered: true });
    return created.map((document) => serializeDocument(document.toObject()));
  }

  async update(entityName: ResourceEntityName, id: string, updates: LooseResourceDocument) {
    const model = this.getModel(entityName);
    const record = await model.findOneAndUpdate(
      { id },
      {
        $set: {
          ...updates,
          id,
          updated_date: new Date().toISOString(),
        },
      },
      { new: true },
    );

    if (!record) {
      throw new NotFoundException(`${entityName} "${id}" was not found.`);
    }

    return serializeDocument(record.toObject());
  }

  async delete(entityName: ResourceEntityName, id: string) {
    const model = this.getModel(entityName);
    const result = await model.deleteOne({ id });
    if (!result.deletedCount) {
      throw new NotFoundException(`${entityName} "${id}" was not found.`);
    }

    return { success: true };
  }
}
