import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { HomeWrite, HomeWriteGuard } from '../home-permissions/home-write.guard';
import { AnnouncementTagsService } from './announcement-tags.service';
import { CreateAnnouncementTagDto } from './dto/create-announcement-tag.dto';
import { UpdateAnnouncementTagDto } from './dto/update-announcement-tag.dto';
import { FindAnnouncementTagsDto } from './dto/find-announcement-tags.dto';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';

/**
 * お知らせ専用タグマスタの REST（rete-home-0043）。
 * 一覧（GET）はログイン済みユーザー全員可。変更とアーカイブを含む一覧はHomeタグ管理権限で制御する。
 * File タグマスタ（GET /tags）とは独立した別系統マスタ。
 */
@ApiTags('announcement-tags')
@Controller('announcement-tags')
@HomeWrite('tags')
@UseGuards(AuthenticatedGuard, HomeWriteGuard)
export class AnnouncementTagsController {
  constructor(private readonly service: AnnouncementTagsService) {}

  @Get()
  @ApiOperation({ summary: 'お知らせタグ一覧（kind でスコープ・name 昇順）' })
  async findAll(@Query() query: FindAnnouncementTagsDto) {
    return this.service.findAll(query);
  }

  // 書き込み系はスパム作成抑制のため throttle を厳しめに設定（tags.controller と同方針）。
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'お知らせタグ作成（Homeタグ管理権限・name + icon + color）' })
  async create(@Body() dto: CreateAnnouncementTagDto) {
    return this.service.create(dto);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Patch(':id')
  @ApiOperation({ summary: 'お知らせタグ更新（Homeタグ管理権限・部分更新）' })
  @ApiParam({ name: 'id', description: 'お知らせタグ ID (UUID)' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAnnouncementTagDto) {
    return this.service.update(id, dto);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Delete(':id')
  @ApiOperation({ summary: 'お知らせタグ削除（Homeタグ管理権限・付与は連鎖削除）' })
  @ApiParam({ name: 'id', description: 'お知らせタグ ID (UUID)' })
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.delete(id);
  }
}
