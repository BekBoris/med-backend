import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RESOURCE_ENTITIES, ResourceEntityName } from '../constants/entities.constant';

export const isResourceEntityName = (value: string): value is ResourceEntityName =>
  RESOURCE_ENTITIES.includes(value as ResourceEntityName);

export const ensureResourceEntityName = (value: string): ResourceEntityName => {
  if (!isResourceEntityName(value)) {
    throw new BadRequestException(`Unsupported entity "${value}".`);
  }

  return value;
};

export const createEntityIdentifier = (entityName: string) =>
  `${entityName.toLowerCase()}-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 10)}`;

export const parseFilter = (rawFilter?: string): Record<string, unknown> => {
  if (!rawFilter) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawFilter);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    throw new BadRequestException('The "filter" query parameter must be a valid JSON object.');
  }

  throw new BadRequestException('The "filter" query parameter must be a valid JSON object.');
};

const normalizeFilterValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return { $in: value };
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, innerValue]) => [
        key,
        normalizeFilterValue(innerValue),
      ]),
    );
  }

  return value;
};

export const buildMongoFilter = (filter: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(filter).map(([key, value]) => [key, normalizeFilterValue(value)]),
  );

export const buildMongoSort = (sortBy?: string): Record<string, 1 | -1> => {
  if (!sortBy) {
    return { created_date: -1 };
  }

  const isDescending = sortBy.startsWith('-');
  const field = isDescending ? sortBy.slice(1) : sortBy;
  return { [field]: isDescending ? -1 : 1 };
};

export const serializeDocument = <T extends Record<string, unknown> | null>(document: T) => {
  if (!document) {
    return null;
  }

  const { _id, __v, ...rest } = document as Record<string, unknown>;
  return rest;
};

export const serializeDocuments = <T extends Record<string, unknown>>(documents: T[]) =>
  documents
    .map((document) => serializeDocument(document))
    .filter((document): document is Record<string, unknown> => Boolean(document));
