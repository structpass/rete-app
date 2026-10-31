import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ForbiddenException, StreamableFile } from '@nestjs/common';
import { Readable } from 'stream';
import { Role } from '@rete/shared';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import type { AuthenticatedUser } from '../auth/auth.service';

const mockService = {
  getTree: jest.fn(),
  getFolderContent: jest.fn(),
  uploadFile: jest.fn(),
  uploadFileVersion: jest.fn(),
  getFileMeta: jest.fn(),
  downloadFile: jest.fn(),
  downloadFileVersion: jest.fn(),
  getSettings: jest.fn(),
  updateSettings: jest.fn(),
  moveFolder: jest.fn(),
  moveFile: jest.fn(),
  deleteFile: jest.fn(),
  deleteFolder: jest.fn(),
  setFileTags: jest.fn(),
  setFolderTags: jest.fn(),
  assignTagsBatch: jest.fn(),
  searchByTags: jest.fn(),
  resolveRefs: jest.fn(),
};

/**
 * controller は認証ユーザーを service へ素通しするだけ（権限判定は service 層・fil-0027）。
 * 委譲検証に必要な最小フィールドだけ持つスタブを使う。
 */
const ACTOR = {
  id: 'account-1',
  role: Role.MEMBER,
} as unknown as AuthenticatedUser;

describe('FilesController', () => {
  let controller: FilesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [{ provide: FilesService, useValue: mockService }],
    }).compile();

    controller = module.get<FilesController>(FilesController);
  });

  it('getTree は spaceId を service.getTree へ委譲する（fil-0137 で必須化）', async () => {
    const expected = { success: true, data: { roots: [] } };
    mockService.getTree.mockResolvedValue(expected);

    expect(await controller.getTree(ACTOR, 'space-1')).toBe(expected);
    expect(mockService.getTree).toHaveBeenCalledWith(ACTOR, 'space-1');
  });

  it('resolveRefs は参照ノードの id と認証ユーザーを service.resolveRefs へ委譲する（fil-0163・d688）', async () => {
    const expected = { success: true, data: { items: [] } };
    mockService.resolveRefs.mockResolvedValue(expected);

    expect(await controller.resolveRefs({ ids: 'folder-1,file-2' }, ACTOR)).toBe(expected);
    expect(mockService.resolveRefs).toHaveBeenCalledWith('folder-1,file-2', ACTOR);
  });

  it('getFolderContent は id を service.getFolderContent へ委譲する', async () => {
    const expected = { success: true, data: { id: 'f', name: 'x', crumb: [], items: [] } };
    mockService.getFolderContent.mockResolvedValue(expected);

    expect(await controller.getFolderContent('f', ACTOR)).toBe(expected);
    expect(mockService.getFolderContent).toHaveBeenCalledWith('f', ACTOR);
  });

  it('uploadFile は folderId / file / uploaderId を service.uploadFile へ委譲する', async () => {
    const file = {
      originalname: 'x.md',
      buffer: Buffer.from('a'),
      size: 1,
      mimetype: 'text/markdown',
    };
    const expected = { success: true, data: { kind: 'file', id: 'file-1', versionNo: 1 } };
    mockService.uploadFile.mockResolvedValue(expected);

    expect(await controller.uploadFile('folder-1', file as never, ACTOR)).toBe(expected);
    expect(mockService.uploadFile).toHaveBeenCalledWith('folder-1', file, ACTOR);
  });

  it('uploadFileVersion は id / file / uploaderId を service.uploadFileVersion へ委譲する（FF）', async () => {
    const file = {
      originalname: 'report.docx',
      buffer: Buffer.from('a'),
      size: 1,
      mimetype: 'application/octet-stream',
    };
    const expected = { success: true, data: { kind: 'file', id: 'file-1', versionNo: 3 } };
    mockService.uploadFileVersion.mockResolvedValue(expected);

    expect(await controller.uploadFileVersion('file-1', file as never, ACTOR)).toBe(expected);
    expect(mockService.uploadFileVersion).toHaveBeenCalledWith('file-1', file, ACTOR);
  });

  it('getFileMeta は id を service.getFileMeta へ委譲する（FF）', async () => {
    const expected = {
      success: true,
      data: { id: 'file-1', name: 'report.docx', folderId: 'folder-1', versionNo: 2 },
    };
    mockService.getFileMeta.mockResolvedValue(expected);

    expect(await controller.getFileMeta('file-1', ACTOR)).toBe(expected);
    expect(mockService.getFileMeta).toHaveBeenCalledWith('file-1', ACTOR);
  });

  it('downloadFile は最新版を StreamableFile（UTF-8 filename 付き attachment）で返す', async () => {
    const stream = Readable.from(['data']);
    mockService.downloadFile.mockResolvedValue({
      stream,
      mimeType: 'text/markdown',
      fileName: '設計メモ.md',
    });

    const result = await controller.downloadFile('file-1', ACTOR);

    expect(mockService.downloadFile).toHaveBeenCalledWith('file-1', ACTOR);
    expect(result).toBeInstanceOf(StreamableFile);
    expect(result.getStream()).toBe(stream);
    const headers = result.getHeaders();
    expect(headers.type).toBe('text/markdown');
    expect(headers.disposition).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('設計メモ.md')}`,
    );
  });

  it('downloadVersion は版番号を service.downloadFileVersion へ委譲し StreamableFile を返す', async () => {
    const stream = Readable.from(['old']);
    mockService.downloadFileVersion.mockResolvedValue({
      stream,
      mimeType: 'application/pdf',
      fileName: '旧.pdf',
    });

    const result = await controller.downloadVersion('file-1', 2, ACTOR);

    expect(mockService.downloadFileVersion).toHaveBeenCalledWith('file-1', 2, ACTOR);
    expect(result).toBeInstanceOf(StreamableFile);
    expect(result.getStream()).toBe(stream);
  });

  it('moveFolder は id / parentFolderId を service.moveFolder へ委譲する', async () => {
    const expected = { success: true, data: { id: 'f', name: 'x', parentFolderId: 'p' } };
    mockService.moveFolder.mockResolvedValue(expected);

    expect(await controller.moveFolder('f', { parentFolderId: 'p' }, ACTOR)).toBe(expected);
    expect(mockService.moveFolder).toHaveBeenCalledWith('f', 'p', ACTOR);
  });

  it('moveFolder は parentFolderId=null（ルート直下）も委譲する', async () => {
    const expected = { success: true, data: { id: 'f', name: 'x', parentFolderId: null } };
    mockService.moveFolder.mockResolvedValue(expected);

    expect(await controller.moveFolder('f', { parentFolderId: null }, ACTOR)).toBe(expected);
    expect(mockService.moveFolder).toHaveBeenCalledWith('f', null, ACTOR);
  });

  it('moveFile は id / folderId を service.moveFile へ委譲する', async () => {
    const expected = { success: true, data: { id: 'file-1', name: 'x', folderId: 'folder-2' } };
    mockService.moveFile.mockResolvedValue(expected);

    expect(await controller.moveFile('file-1', { folderId: 'folder-2' }, ACTOR)).toBe(expected);
    expect(mockService.moveFile).toHaveBeenCalledWith('file-1', 'folder-2', ACTOR);
  });

  it('getSettings は service.getSettings へ委譲する', async () => {
    const expected = { success: true, data: { maxSizeBytes: 1024, allowedExtensions: [] } };
    mockService.getSettings.mockResolvedValue(expected);

    expect(await controller.getSettings()).toBe(expected);
    expect(mockService.getSettings).toHaveBeenCalledTimes(1);
  });

  it('updateSettings は dto を service.updateSettings へ委譲する', async () => {
    const dto = { maxSizeBytes: 2048, allowedExtensions: ['.pdf'] };
    const expected = { success: true, data: dto };
    mockService.updateSettings.mockResolvedValue(expected);

    expect(await controller.updateSettings(dto)).toBe(expected);
    expect(mockService.updateSettings).toHaveBeenCalledWith(dto);
  });

  it('deleteFile は id を service.deleteFile へ委譲する', async () => {
    const expected = { success: true, data: { id: 'file-1' } };
    mockService.deleteFile.mockResolvedValue(expected);

    expect(await controller.deleteFile('file-1', ACTOR)).toBe(expected);
    expect(mockService.deleteFile).toHaveBeenCalledWith('file-1', ACTOR);
  });

  it('deleteFolder は id を service.deleteFolder へ委譲する', async () => {
    const expected = { success: true, data: { id: 'folder-1' } };
    mockService.deleteFolder.mockResolvedValue(expected);

    expect(await controller.deleteFolder('folder-1', ACTOR)).toBe(expected);
    expect(mockService.deleteFolder).toHaveBeenCalledWith('folder-1', ACTOR);
  });

  it('setFileTags は id と tagIds を service.setFileTags へ委譲する（cmn-0039 / rete-files-0033）', async () => {
    const expected = { success: true, data: { kind: 'file', id: 'file-1' } };
    mockService.setFileTags.mockResolvedValue(expected);

    expect(await controller.setFileTags('file-1', { tagIds: ['t1'] }, ACTOR)).toBe(expected);
    expect(mockService.setFileTags).toHaveBeenCalledWith('file-1', ['t1'], ACTOR);
  });

  it('setFolderTags は id と tagIds を service.setFolderTags へ委譲する（rete-files-0033）', async () => {
    const expected = { success: true, data: { kind: 'folder', id: 'folder-1' } };
    mockService.setFolderTags.mockResolvedValue(expected);

    expect(await controller.setFolderTags('folder-1', { tagIds: ['t1'] }, ACTOR)).toBe(expected);
    expect(mockService.setFolderTags).toHaveBeenCalledWith('folder-1', ['t1'], ACTOR);
  });

  it('assignTagsBatch は dto を service.assignTagsBatch へ委譲する（rete-files-0034 / fil-0048）', async () => {
    const dto = { fileIds: ['f1'], folderIds: ['d1'], addTagIds: ['t1'], removeTagIds: ['t2'] };
    const expected = {
      success: true,
      data: { fileCount: 1, folderCount: 1, addCount: 1, removeCount: 1 },
    };
    mockService.assignTagsBatch.mockResolvedValue(expected);

    expect(await controller.assignTagsBatch(dto, ACTOR)).toBe(expected);
    expect(mockService.assignTagsBatch).toHaveBeenCalledWith(dto, ACTOR);
  });

  it('searchByTags は query.tagIds を service.searchByTags へ委譲する（rete-files-0032）', async () => {
    const expected = { success: true, data: { tagIds: ['t1'], items: [] } };
    mockService.searchByTags.mockResolvedValue(expected);

    expect(await controller.searchByTags({ tagIds: ['t1'] }, ACTOR)).toBe(expected);
    expect(mockService.searchByTags).toHaveBeenCalledWith(['t1'], ACTOR);
  });
});

/** cmn-0025: PATCH /files/settings は ADMIN 限定（RolesGuard integration）。
 *  Guard を override せず実際の RolesGuard を使い、MEMBER が設定更新へアクセスすると
 *  ForbiddenException、ADMIN は通過することを確認する（settings.controller.spec と同方針）。
 */
describe('FilesController — cmn-0025: 設定更新は ADMIN のみ（RolesGuard integration）', () => {
  let controller: FilesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [{ provide: FilesService, useValue: mockService }],
    })
      .overrideGuard(AuthenticatedGuard)
      .useValue({ canActivate: () => true })
      // RolesGuard は override せずに実態を使う
      .compile();

    controller = module.get<FilesController>(FilesController);
  });

  it('MEMBER が PATCH /files/settings にアクセスすると RolesGuard が 403 を返すこと', async () => {
    const { Reflector } = await import('@nestjs/core');
    const reflector = new Reflector();
    const { RolesGuard: Guard } = await import('../auth/guards/roles.guard');
    const guard = new Guard(reflector);

    const ctx = {
      getHandler: () => controller.updateSettings,
      getClass: () => FilesController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: 'acc-1', role: Role.MEMBER } }),
      }),
    } as never;

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('ADMIN が PATCH /files/settings にアクセスすると RolesGuard が通過すること', async () => {
    const { Reflector } = await import('@nestjs/core');
    const reflector = new Reflector();
    const { RolesGuard: Guard } = await import('../auth/guards/roles.guard');
    const guard = new Guard(reflector);

    const ctx = {
      getHandler: () => controller.updateSettings,
      getClass: () => FilesController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: 'acc-1', role: Role.ADMIN } }),
      }),
    } as never;

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('getSettings（@Roles 無し・読み取り系）は MEMBER でも RolesGuard を通過すること（回帰防止）', async () => {
    const { Reflector } = await import('@nestjs/core');
    const reflector = new Reflector();
    const { RolesGuard: Guard } = await import('../auth/guards/roles.guard');
    const guard = new Guard(reflector);

    const ctx = {
      getHandler: () => controller.getSettings,
      getClass: () => FilesController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: 'acc-1', role: Role.MEMBER } }),
      }),
    } as never;

    expect(guard.canActivate(ctx)).toBe(true);
  });
});
