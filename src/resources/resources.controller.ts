import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ResourceQueryDto } from '../common/dto/resource-query.dto';
import { ensureResourceEntityName } from '../common/utils/entity.utils';
import { ResourcesService } from './resources.service';

@ApiTags('entities')
@Controller('entities')
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @Get(':entity')
  list(
    @Param('entity') entity: string,
    @Query() query: ResourceQueryDto,
  ) {
    return this.resourcesService.list(ensureResourceEntityName(entity), query);
  }

  @Get(':entity/:id')
  get(@Param('entity') entity: string, @Param('id') id: string) {
    return this.resourcesService.get(ensureResourceEntityName(entity), id);
  }

  @Post(':entity/bulk')
  bulkCreate(@Param('entity') entity: string, @Body() body: unknown) {
    const items = Array.isArray(body)
      ? body
      : Array.isArray((body as { items?: unknown[] })?.items)
        ? (body as { items: unknown[] }).items
        : [];

    return this.resourcesService.bulkCreate(
      ensureResourceEntityName(entity),
      items as Record<string, unknown>[],
    );
  }

  @Post(':entity')
  create(@Param('entity') entity: string, @Body() body: Record<string, unknown>) {
    return this.resourcesService.create(ensureResourceEntityName(entity), body);
  }

  @Patch(':entity/:id')
  update(
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.resourcesService.update(ensureResourceEntityName(entity), id, body);
  }

  @Delete(':entity/:id')
  delete(@Param('entity') entity: string, @Param('id') id: string) {
    return this.resourcesService.delete(ensureResourceEntityName(entity), id);
  }
}
